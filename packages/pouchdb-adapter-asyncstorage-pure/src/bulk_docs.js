'use strict'

import {
  createError,
  generateErrorFromResponse,
  BAD_ARG, MISSING_DOC, REV_CONFLICT } from 'pouchdb-errors'
import { parseDoc } from 'pouchdb-adapter-utils'
import { merge } from 'pouchdb-merge'
import { binaryStringToBlobOrBuffer } from 'pouchdb-binary-utils'

import { forDocument, forMeta, forSequence } from './keys'

export default function (db, req, opts, callback) {
  const wasDelete = 'was_delete' in opts
  const newEdits = opts.new_edits
  const revsLimit = db.opts.revs_limit || 1000
  const newMeta = {...db.meta}

  const mapRequestDoc = doc => {
    const parsedDoc = parseDoc(doc, newEdits)
    return {
      id: parsedDoc.metadata.id,
      rev: parsedDoc.metadata.rev,
      rev_tree: parsedDoc.metadata.rev_tree,
      deleted: !!parsedDoc.metadata.deleted,
      data: parsedDoc.data
    }
  }

  const preProcessAllAttachments = data => {
    const binaryMd5 = (data, callback) => {
      // const base64 = md5(data)
      callback('123')
    }

    const parseBase64 = data => {
      try {
        return global.atob(data)
      } catch (error) {
        return {
          error: createError(BAD_ARG, 'Attachment is not a valid base64 string')
        }
      }
    }

    const preProcessAttachment = attachment => {
      if (!attachment.data) {
        return Promise.resolve(attachment)
      }

      let binData
      if (typeof attachment.data === 'string') {
        binData = parseBase64(attachment.data)
        if (binData.error) {
          return Promise.reject(binData.error)
        }
        attachment = binaryStringToBlobOrBuffer(binData, attachment.content_type)
      } else {
        binData = attachment.data
      }

      return new Promise(resolve => {
        binaryMd5(binData, md5 => {
          attachment.digest = 'md5-' + md5
          attachment.length = binData.size || binData.length || 0
          resolve(attachment)
        })
      })
    }

    if (!data._attachments) return Promise.resolve(data)

    const promises = Object.keys(data._attachments).map(key => {
      return preProcessAttachment(data._attachments[key])
        .then(attachment => { data._attachments[key] = attachment })
    })

    return Promise.all(promises)
  }

  const getChange = (oldDoc, newDoc) => {
    // pouchdb magic
    const rootIsMissing = doc => doc.rev_tree[0].ids[1].status === 'missing'
    const getUpdate = () => {
      // Ignore updates to existing revisions
      if (newDoc.rev in oldDoc.rev_map) return {}

      const merged = merge(oldDoc.rev_tree, newDoc.rev_tree[0], revsLimit)
      newDoc.rev_tree = merged.tree

      const inConflict = newEdits && (((oldDoc.deleted && newDoc.deleted) ||
         (!oldDoc.deleted && merged.conflicts !== 'new_leaf') ||
         (oldDoc.deleted && !newDoc.deleted && merged.conflicts === 'new_branch')))

      if (inConflict) {
        return {error: createError(REV_CONFLICT)}
      }

      if (oldDoc.deleted && !newDoc.deleted) newMeta.doc_count ++
      else if (!oldDoc.deleted && newDoc.deleted) newMeta.doc_count --

      newDoc.seq = ++newMeta.update_seq
      newDoc.rev_map = oldDoc.rev_map
      newDoc.rev_map[newDoc.rev] = newDoc.seq
      newDoc.winningRev = newDoc.rev

      const data = newDoc.data
      delete newDoc.data
      data._id = newDoc.id
      data._rev = newDoc.rev

      return {
        doc: [forDocument(newDoc.id), newDoc],
        data: [forSequence(newDoc.seq), data],
        result: {
          ok: true,
          id: newDoc.id,
          rev: newDoc.deleted ? '0-0' : newDoc.rev
        }
      }
    }
    const getInsert = () => {
      const merged = merge([], newDoc.rev_tree[0], revsLimit)
      newDoc.rev_tree = merged.tree
      newDoc.seq = ++newMeta.update_seq
      newDoc.rev_map = {}
      newDoc.rev_map[newDoc.rev] = newDoc.seq
      newDoc.winningRev = newDoc.rev
      if (!newDoc.deleted) newMeta.doc_count ++

      const data = newDoc.data
      delete newDoc.data
      data._id = newDoc.id
      data._rev = newDoc.rev

      return {
        doc: [forDocument(newDoc.id), newDoc],
        data: [forSequence(newDoc.seq), data],
        result: {
          ok: true,
          id: newDoc.id,
          rev: newDoc.deleted ? '0-0' : newDoc.rev
        }
      }
    }

    return new Promise((resolve, reject) => {
      if (wasDelete && !oldDoc) {
        return reject(createError(MISSING_DOC, 'deleted'))
      }
      if (newEdits && !oldDoc && rootIsMissing(newDoc)) {
        return reject(createError(REV_CONFLICT))
      }

      preProcessAllAttachments(newDoc.data)
        .then(data => {
          const change = oldDoc ? getUpdate() : getInsert()
          if (change.error) return reject(change.error)
          resolve(change)
        })
        .catch(reject)
    })
  }

  let newDocs
  try {
    newDocs = req.docs.map(mapRequestDoc)
  } catch (error) {
    return callback(generateErrorFromResponse(error))
  }

  const docIds = newDocs.map(doc => forDocument(doc.id))
  db.storage.multiGet(docIds, (error, oldDocs) => {
    if (error) return callback(generateErrorFromResponse(error))

    const oldDocsObj = oldDocs.reduce(
      (result, doc) => {
        if (doc && doc.id) result[doc.id] = doc
        return result
      }, {})

    const promises = newDocs.map(newDoc => getChange(oldDocsObj[newDoc.id], newDoc))
    Promise.all(promises)
      .then(changes => {
        if (changes.length === 0) return callback(null, {})

        const dbChanges = changes.map(item => item.doc)
          .concat(changes.map(item => item.data))
        dbChanges.push([forMeta('_local_doc_count'), newMeta.doc_count])
        dbChanges.push([forMeta('_local_last_update_seq'), newMeta.update_seq])

        db.storage.multiPut(dbChanges, error => {
          if (error) return callback(generateErrorFromResponse(error))

          db.meta.doc_count = newMeta.doc_count
          db.meta.update_seq = newMeta.update_seq
          db.changes.notify(db.opts.name)

          callback(null, changes.map(change => change.result))
        })
      })
      .catch(callback)
  })
}
