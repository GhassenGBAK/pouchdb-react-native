'use strict'

import { createError } from 'pouchdb-errors'
import { collectConflicts } from 'pouchdb-merge'

const getDocs = (db,
  {filterKey, startkey, endkey, skip, limit, inclusiveEnd, includeDeleted},
  callback) => {
  db.storage.getKeys((error, keys) => {
    if (error) return callback(error)

    const filterKeys = keys.filter(key => {
      if (startkey && startkey > key) return false
      if (endkey) return inclusiveEnd ? endkey >= key : endkey > key
      if (filterKey) return filterKey === key

      return true
    })

    db.storage.multiGet(filterKeys, (error, docs) => {
      if (error) return callback(error)

      let result = includeDeleted
        ? docs
        : docs.filter(doc => !doc.deleted)

      if (skip > 0) result = result.slice(skip)
      if (limit > 0 && result.length > limit) result = result.slice(0, limit)

      callback(null, result)
    })
  })
}

export default function (db, opts, callback) {
  // get options like pouchdb-adapter-indexeddb
  const startkey = 'startkey' in opts ? opts.startkey : false
  const endkey = 'endkey' in opts ? opts.endkey : false
  const filterKey = 'key' in opts ? opts.key : false
  const skip = opts.skip || 0
  const limit = typeof opts.limit === 'number' ? opts.limit : -1
  const inclusiveEnd = opts.inclusive_end !== false
  const includeDeleted = 'deleted' in opts ? opts.deleted === 'ok' : false
  const includeDoc = 'include_docs' in opts ? opts.include_docs : true
  const descending = 'descending' in opts && opts.descending

  const docToRow = doc => {
    if (includeDoc) {
      return {
        id: doc.id,
        key: doc.id,
        value: {
          rev: doc.rev
        },
        doc: Object.assign({}, doc.data, {
          _id: doc.id,
          _rev: doc.id,
          _conflicts: opts.conflicts ? collectConflicts(doc) : null
        })
      }
    }

    return {
      id: doc.id,
      key: doc.id,
      value: {
        rev: doc.rev
      }
    }
  }

  getDocs(db, {filterKey, startkey, endkey, skip, limit, inclusiveEnd, includeDeleted},
    (error, docs) => {
      if (error) return callback(createError(error, 'get_docs'))

      let rows = docs.map(docToRow)
      if (descending) rows = rows.reverse()

      callback(null, {
        total_rows: db.meta.doc_count,
        offset: opts.skip,
        rows
      })
    }
  )
}
