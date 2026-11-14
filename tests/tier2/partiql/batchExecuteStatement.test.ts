import {
  BatchExecuteStatementCommand,
  ExecuteStatementCommand,
  TransactWriteItemsCommand,
  PutItemCommand,
  GetItemCommand,
  DynamoDBServiceException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { isUnsupportedFault } from '../../../src/infra.js'
import {
  declareTables,
  hashTableDef,
  partiqlIndexTableDef,
  cleanupItems,
  expectDynamoError,
  absentTableName,
} from '../../../src/helpers.js'

declareTables(hashTableDef, partiqlIndexTableDef)

describe('BatchExecuteStatement — PartiQL', { tags: ['partiql', 'data-plane', 'gsi', 'lsi'] }, () => {
  let supported = true

  const keysToCleanup: Record<string, { S: string }>[] = []

  beforeAll(async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT * FROM "${hashTableDef.name}" WHERE pk = 'partiql-canary'`,
      }))
    } catch (e: unknown) {
      // isUnsupportedFault is the suite's definition of "not implemented", so a
      // target signalling it any recognised way (including HTTP 501) skips here
      // rather than failing every PartiQL test. UnrecognizedClientException is
      // kept alongside it: it is a credentials rejection, not an unsupported
      // fault, but it is how at least one target declines PartiQL.
      if (isUnsupportedFault(e) || (e instanceof Error && e.name === 'UnrecognizedClientException')) {
        supported = false
      }
    }
  })

  beforeEach(({ skip }) => { if (!supported) skip() })

  afterAll(async () => {
    if (keysToCleanup.length > 0) {
      await cleanupItems(hashTableDef.name, keysToCleanup)
    }
  })

  it('batch of multiple SELECT statements', async () => {
    keysToCleanup.push(
      { pk: { S: 'batch-sel-1' } },
      { pk: { S: 'batch-sel-2' } },
    )

    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: 'batch-sel-1' }, data: { S: 'one' } },
    }))
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: 'batch-sel-2' }, data: { S: 'two' } },
    }))

    const result = await ddb.send(new BatchExecuteStatementCommand({
      Statements: [
        { Statement: `SELECT * FROM "${hashTableDef.name}" WHERE pk = 'batch-sel-1'` },
        { Statement: `SELECT * FROM "${hashTableDef.name}" WHERE pk = 'batch-sel-2'` },
      ],
    }))

    expect(result.Responses).toBeDefined()
    expect(result.Responses!.length).toBe(2)

    const items = result.Responses!.map(r => r.Item)
    const pks = items.map(i => i?.pk.S).sort()
    expect(pks).toEqual(['batch-sel-1', 'batch-sel-2'])
  })

  it('batch of INSERT and UPDATE statements', async () => {
    keysToCleanup.push(
      { pk: { S: 'batch-ins-1' } },
      { pk: { S: 'batch-upd-1' } },
    )

    // Seed an item for the UPDATE
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: 'batch-upd-1' }, data: { S: 'before' } },
    }))

    const result = await ddb.send(new BatchExecuteStatementCommand({
      Statements: [
        { Statement: `INSERT INTO "${hashTableDef.name}" VALUE {'pk': 'batch-ins-1', 'data': 'new'}` },
        { Statement: `UPDATE "${hashTableDef.name}" SET data = 'after' WHERE pk = 'batch-upd-1'` },
      ],
    }))

    expect(result.Responses).toBeDefined()
    expect(result.Responses!.length).toBe(2)

    // Verify the INSERT
    const inserted = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name,
      Key: { pk: { S: 'batch-ins-1' } },
      ConsistentRead: true,
    }))
    expect(inserted.Item).toBeDefined()
    expect(inserted.Item!.data.S).toBe('new')

    // Verify the UPDATE
    const updated = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name,
      Key: { pk: { S: 'batch-upd-1' } },
      ConsistentRead: true,
    }))
    expect(updated.Item).toBeDefined()
    expect(updated.Item!.data.S).toBe('after')
  })

  it('partial failure — one valid and one invalid statement', async () => {
    keysToCleanup.push({ pk: { S: 'batch-partial-1' } })

    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: 'batch-partial-1' }, data: { S: 'exists' } },
    }))

    const result = await ddb.send(new BatchExecuteStatementCommand({
      Statements: [
        { Statement: `SELECT * FROM "${hashTableDef.name}" WHERE pk = 'batch-partial-1'` },
        { Statement: `SELECT * FROM "${absentTableName('nonexistent_table')}" WHERE pk = 'x'` },
      ],
    }))

    expect(result.Responses).toBeDefined()
    expect(result.Responses!.length).toBe(2)

    // One response should succeed, the other should have an Error
    const errors = result.Responses!.filter(r => r.Error)
    const successes = result.Responses!.filter(r => !r.Error)
    expect(errors.length).toBe(1)
    expect(successes.length).toBe(1)
    expect(errors[0].Error!.Code).toBe('ResourceNotFound')
  })

  it('honours a RETURNING clause on a member statement', async () => {
    const pk = 'batch-ret-allold'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, data: { S: 'batchgone' } },
    }))

    const result = await ddb.send(new BatchExecuteStatementCommand({
      Statements: [
        { Statement: `DELETE FROM "${hashTableDef.name}" WHERE pk = '${pk}' RETURNING ALL OLD *` },
      ],
    }))

    // Unlike ExecuteTransaction, BatchExecuteStatement honours RETURNING — the
    // deleted item surfaces on Responses[i].Item. Characterised against real
    // AWS (eu-west-2). See #102.
    expect(result.Responses).toBeDefined()
    expect(result.Responses!.length).toBe(1)
    expect(result.Responses![0].Item).toBeDefined()
    expect(result.Responses![0].Item!.pk.S).toBe(pk)
    expect(result.Responses![0].Item!.data.S).toBe('batchgone')

    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name,
      Key: { pk: { S: pk } },
      ConsistentRead: true,
    }))
    expect(after.Item).toBeUndefined()
  })

  it('honours a RETURNING ALL NEW * clause on a member UPDATE', async () => {
    const pk = 'batch-ret-upd-allnew'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, data: { S: 'old' } },
    }))

    const result = await ddb.send(new BatchExecuteStatementCommand({
      Statements: [
        { Statement: `UPDATE "${hashTableDef.name}" SET data = 'new' WHERE pk = '${pk}' RETURNING ALL NEW *` },
      ],
    }))

    // An UPDATE member projects the same shape as the ExecuteStatement path,
    // onto Responses[i].Item. ALL NEW * returns the full new item incl. the key.
    expect(result.Responses).toBeDefined()
    expect(result.Responses!.length).toBe(1)
    expect(result.Responses![0].Item!.pk.S).toBe(pk)
    expect(result.Responses![0].Item!.data.S).toBe('new')
  })

  it('honours a RETURNING MODIFIED NEW * clause on a member UPDATE (only the changed attr)', async () => {
    const pk = 'batch-ret-upd-modnew'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, data: { S: 'old' } },
    }))

    const result = await ddb.send(new BatchExecuteStatementCommand({
      Statements: [
        { Statement: `UPDATE "${hashTableDef.name}" SET data = 'new' WHERE pk = '${pk}' RETURNING MODIFIED NEW *` },
      ],
    }))

    expect(result.Responses).toBeDefined()
    expect(result.Responses!.length).toBe(1)
    const item = result.Responses![0].Item
    expect(item).toBeDefined()
    expect(Object.keys(item!)).toEqual(['data'])
    expect(item!.data.S).toBe('new')
  })

  it('omits Item when a member UPDATE produces an empty MODIFIED projection', async () => {
    const pk = 'batch-ret-upd-modempty'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, data: { S: 'old' } },
    }))

    const result = await ddb.send(new BatchExecuteStatementCommand({
      Statements: [
        { Statement: `UPDATE "${hashTableDef.name}" REMOVE data WHERE pk = '${pk}' RETURNING MODIFIED NEW *` },
      ],
    }))

    // ExecuteStatement expresses an empty MODIFIED projection as Items: [];
    // the batch path's singular Item field cannot hold an empty row, so the
    // field is omitted entirely (not Item: {}). TableName is still echoed.
    expect(result.Responses).toBeDefined()
    expect(result.Responses!.length).toBe(1)
    expect(result.Responses![0].Item).toBeUndefined()
    expect(result.Responses![0].TableName).toBe(hashTableDef.name)

    // The member statement did apply: the attribute is gone.
    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } }, ConsistentRead: true,
    }))
    expect(after.Item!.data).toBeUndefined()
  })

  it('surfaces an invalid RETURNING variant on a member DELETE as a per-statement error', async () => {
    // The batch call itself succeeds (HTTP 200, no throw); the invalid variant
    // surfaces per-statement with Code 'ValidationError' (not the single-statement
    // path's thrown 'ValidationException' name) and the same verbatim message.
    const result = await ddb.send(new BatchExecuteStatementCommand({
      Statements: [
        { Statement: `DELETE FROM "${hashTableDef.name}" WHERE pk = 'batch-ret-badvariant' RETURNING MODIFIED OLD *` },
      ],
    }))

    expect(result.Responses).toBeDefined()
    expect(result.Responses!.length).toBe(1)
    const err = result.Responses![0].Error
    expect(err).toBeDefined()
    expect(err!.Code).toBe('ValidationError')
    expect(err!.Message).toBe(
      'Invalid returning clause: RETURNING MODIFIED OLD *. Only RETURNING ALL OLD * is allowed in DELETE statements.',
    )
  })

  it('surfaces a malformed member statement as a per-statement ValidationError without failing the batch', async () => {
    const pk = 'batch-parse-ok'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, data: { S: 'valid' } },
    }))

    // A member that fails to parse (SLECT) surfaces per-statement with the short
    // Code 'ValidationError' — the same Code as an execution error, not the
    // single-statement path's thrown 'ValidationException'. The batch call itself
    // returns 200 and a valid sibling member still executes. Characterised against
    // real AWS (eu-west-2). See #102.
    const result = await ddb.send(new BatchExecuteStatementCommand({
      Statements: [
        { Statement: `SLECT * FROM "${hashTableDef.name}" WHERE pk = '${pk}'` },
        { Statement: `SELECT * FROM "${hashTableDef.name}" WHERE pk = '${pk}'` },
      ],
    }))

    expect(result.Responses).toBeDefined()
    expect(result.Responses!.length).toBe(2)

    const err = result.Responses![0].Error
    expect(err).toBeDefined()
    expect(err!.Code).toBe('ValidationError')
    expect(err!.Message).toBe(
      "Statement wasn't well formed, can't be processed: Expected data manipulation",
    )

    // The valid sibling still executed — a malformed member does not poison the batch.
    expect(result.Responses![1].Error).toBeUndefined()
    expect(result.Responses![1].Item).toBeDefined()
    expect(result.Responses![1].Item!.data.S).toBe('valid')
  })

  it('rejects an empty Statements array', async () => {
    await expectDynamoError(
      () => ddb.send(new BatchExecuteStatementCommand({
        Statements: [],
      })),
      'ValidationException',
    )
  })

  // ConsistentRead is carried per member and it is not inert. The mixed batch is
  // the case that proves it: the total is the sum of two differently-rated
  // members rather than one mode applied to the whole batch.
  describe('ConsistentRead is honoured per member', () => {
    const K = (n: string) => `batch-cr-${n}`

    async function batchSelect(members: { key: string; consistent?: boolean }[]) {
      const res = await ddb.send(new BatchExecuteStatementCommand({
        Statements: members.map((m) => ({
          Statement: `SELECT * FROM "${hashTableDef.name}" WHERE pk = ?`,
          Parameters: [{ S: m.key }],
          ...(m.consistent === undefined ? {} : { ConsistentRead: m.consistent }),
        })),
        ReturnConsumedCapacity: 'TOTAL',
      }))
      const cc = res.ConsumedCapacity ?? []
      return {
        responses: res.Responses ?? [],
        total: cc.reduce((sum, c) => sum + (c.CapacityUnits ?? 0), 0),
      }
    }

    beforeAll(async () => {
      if (!supported) return
      for (const n of ['a', 'b']) {
        const key = { pk: { S: K(n) } }
        keysToCleanup.push(key)
        await ddb.send(new PutItemCommand({
          TableName: hashTableDef.name, Item: { ...key, val: { S: n } },
        }))
      }
    })

    it('charges a small eventually-consistent read half a unit', async () => {
      const r = await batchSelect([{ key: K('a') }])
      expect(r.responses[0].Item).toBeDefined()
      expect(r.total).toBe(0.5)
    })

    it('charges exactly twice that when the member asks for consistency', async () => {
      const eventual = await batchSelect([{ key: K('a') }])
      const consistent = await batchSelect([{ key: K('a'), consistent: true }])
      expect(consistent.total).toBe(eventual.total * 2)
    })

    it('treats an explicit false the same as omitting it', async () => {
      const omitted = await batchSelect([{ key: K('a') }])
      const explicit = await batchSelect([{ key: K('a'), consistent: false }])
      expect(explicit.total).toBe(omitted.total)
    })

    // One consistent member and one eventual: the sum of the two rates, not
    // twice either of them.
    it('rates each member of a mixed batch on its own setting', async () => {
      const eventual = await batchSelect([{ key: K('a') }])
      const consistent = await batchSelect([{ key: K('a'), consistent: true }])
      const mixed = await batchSelect([
        { key: K('a'), consistent: true },
        { key: K('b') },
      ])
      expect(mixed.total).toBe(consistent.total + eventual.total)
    })
  })

  // A batch SELECT must name the table primary key. That rejection also swallows
  // the index case, so an index-served read is not reachable from a batch at all
  // and the surface owes a validation rather than an index capacity arm.
  describe('a batch SELECT must name the table primary key', () => {
    async function memberError(Statement: string) {
      const res = await ddb.send(new BatchExecuteStatementCommand({
        Statements: [{ Statement }],
      }))
      return res.Responses?.[0]
    }

    it('rejects a member that filters on a non-key attribute', async () => {
      const r = await memberError(`SELECT * FROM "${hashTableDef.name}" WHERE val = 'a'`)
      expect(r?.Error?.Code).toBe('ValidationError')
      expect(r?.Error?.Message).toContain('must specify the primary key in the where clause')
    })

    it('rejects an index-qualified member naming the index key', async () => {
      const r = await memberError(
        `SELECT * FROM "${partiqlIndexTableDef.name}"."gsi-all" WHERE gsiPk = 'x'`,
      )
      expect(r?.Error?.Code).toBe('ValidationError')
      expect(r?.Error?.Message).toContain('must specify the primary key in the where clause')
    })

    // Even naming the table key alongside the index key does not reach it.
    it('rejects one naming both the table primary key and the index key', async () => {
      const r = await memberError(
        `SELECT * FROM "${partiqlIndexTableDef.name}"."gsi-all" WHERE pk = 'p' AND sk = 's1' AND gsiPk = 'x'`,
      )
      expect(r?.Error?.Code).toBe('ValidationError')
      expect(r?.Error?.Message).toContain('must specify the primary key in the where clause')
    })

    // Captured in eu-west-2 and us-east-1, 2026-11-14. The primary key means all
    // of it: on a composite table the partition key alone is rejected.
    it('rejects a member naming the partition key but not the sort key', async () => {
      const r = await memberError(`SELECT * FROM "${partiqlIndexTableDef.name}" WHERE pk = 'p'`)
      expect(r?.Error?.Code).toBe('ValidationError')
      expect(r?.Error?.Message).toContain('must specify the primary key in the where clause')
    })

    it('leaves the rest of the batch running', async () => {
      const key = { pk: { S: 'batch-pk-ok' } }
      keysToCleanup.push(key)
      await ddb.send(new PutItemCommand({
        TableName: hashTableDef.name, Item: { ...key, val: { S: 'here' } },
      }))

      const res = await ddb.send(new BatchExecuteStatementCommand({
        Statements: [
          { Statement: `SELECT * FROM "${hashTableDef.name}" WHERE val = 'nope'` },
          { Statement: `SELECT * FROM "${hashTableDef.name}" WHERE pk = 'batch-pk-ok'` },
        ],
      }))
      expect(res.Responses![0].Error?.Code).toBe('ValidationError')
      expect(res.Responses![1].Item).toBeDefined()
    })
  })

  // TableName is echoed on a member that ran and failed, and absent on one
  // rejected before it ran. The split tracks whether the statement reached its
  // table at all.
  describe('a failed member echoes its table only if it ran', () => {
    const K = (n: string) => `batch-tn-${n}`

    it('carries TableName on a conditional failure', async () => {
      const key = { pk: { S: K('cond') } }
      keysToCleanup.push(key)
      await ddb.send(new PutItemCommand({
        TableName: hashTableDef.name, Item: { ...key, val: { S: 'here' } },
      }))

      const res = await ddb.send(new BatchExecuteStatementCommand({
        Statements: [{
          Statement: `UPDATE "${hashTableDef.name}" SET touched = 'yes' WHERE pk = ? AND val = ?`,
          Parameters: [{ S: K('cond') }, { S: 'wrong' }],
        }],
      }))
      expect(res.Responses![0].Error?.Code).toBe('ConditionalCheckFailed')
      expect(res.Responses![0].TableName).toBe(hashTableDef.name)
    })

    it('carries TableName on a duplicate insert', async () => {
      const key = { pk: { S: K('dup') } }
      keysToCleanup.push(key)
      await ddb.send(new PutItemCommand({ TableName: hashTableDef.name, Item: key }))

      const res = await ddb.send(new BatchExecuteStatementCommand({
        Statements: [{
          Statement: `INSERT INTO "${hashTableDef.name}" VALUE {'pk': ?}`,
          Parameters: [{ S: K('dup') }],
        }],
      }))
      expect(res.Responses![0].Error?.Code).toBe('DuplicateItem')
      expect(res.Responses![0].TableName).toBe(hashTableDef.name)
    })

    it('omits TableName on a member rejected before it ran', async () => {
      const res = await ddb.send(new BatchExecuteStatementCommand({
        Statements: [{ Statement: `SELECT * FROM "${hashTableDef.name}" WHERE val = 'a'` }],
      }))
      expect(res.Responses![0].Error?.Code).toBe('ValidationError')
      expect(res.Responses![0].TableName).toBeUndefined()
    })
  })

  // With ALL_OLD, a batch member whose condition fails carries the existing item
  // on its Error, never on the member itself. NONE and an absent option return
  // no item. Captured in eu-west-2 and us-east-1 on 2026-10-10, identical in both.
  describe('ReturnValuesOnConditionCheckFailure on a batch member', () => {
    const KEY = 'batch-rvocf'

    beforeAll(async () => {
      if (!supported) return
      const key = { pk: { S: KEY } }
      keysToCleanup.push(key)
      await ddb.send(new PutItemCommand({
        TableName: hashTableDef.name, Item: { ...key, val: { S: 'here' } },
      }))
    })

    const SETTINGS = ['ALL_OLD', 'NONE', undefined] as const

    it.each(SETTINGS)('returns no Item with the option set to %s', async (setting) => {
      const res = await ddb.send(new BatchExecuteStatementCommand({
        Statements: [{
          Statement: `UPDATE "${hashTableDef.name}" SET touched = 'yes' WHERE pk = ? AND val = ?`,
          Parameters: [{ S: KEY }, { S: 'wrong' }],
          ...(setting === undefined ? {} : { ReturnValuesOnConditionCheckFailure: setting }),
        }],
      }))
      expect(res.Responses![0].Error?.Code).toBe('ConditionalCheckFailed')
      expect(res.Responses![0].Item).toBeUndefined()
      expect(res.Responses![0].Error?.Item).toEqual(
        setting === 'ALL_OLD' ? { pk: { S: KEY }, val: { S: 'here' } } : undefined,
      )
    })

    // The same option on a TransactWriteItems ConditionCheck returns the failed
    // item on the cancellation reason, the neighbouring surface's form of it.
    //
    // It is also the one test here that leaves the batch surface, so it is the
    // one that can meet a target implementing PartiQL without transactions.
    // The file-level canary only speaks for ExecuteStatement, and an
    // unsupported answer to this call is scope rather than a disagreement
    // about ReturnValuesOnConditionCheckFailure. Guarded on the call the test
    // already makes rather than on a probe of its own: a probe would have to
    // send a differently shaped request, and a target can answer an empty
    // TransactItems with a validation error while still not implementing the
    // operation.
    it('does return the item on a TransactWriteItems ConditionCheck', async ({ skip }) => {
      try {
        await ddb.send(new TransactWriteItemsCommand({
          TransactItems: [{
            ConditionCheck: {
              TableName: hashTableDef.name,
              Key: { pk: { S: KEY } },
              ConditionExpression: 'val = :v',
              ExpressionAttributeValues: { ':v': { S: 'wrong' } },
              ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
            },
          }],
        }))
        expect.unreachable('should have thrown')
      } catch (err) {
        if (isUnsupportedFault(err)) return skip()
        expect(err).toBeInstanceOf(DynamoDBServiceException)
        const e = err as DynamoDBServiceException & { CancellationReasons?: { Item?: unknown }[] }
        expect(e.name).toBe('TransactionCanceledException')
        expect(e.CancellationReasons?.[0]?.Item).toEqual({ pk: { S: KEY }, val: { S: 'here' } })
      }
    })
  })
})
