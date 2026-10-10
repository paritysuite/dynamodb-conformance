import {
  TransactWriteItemsCommand,
  PutItemCommand,
  GetItemCommand,
  DynamoDBServiceException,
  ResourceNotFoundException,
  TransactionCanceledException,
  type TransactWriteItem,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { skipUnlessSupported } from '../../../src/infra.js'
import {
  hashTableDef,
  hashBTableDef,
  cleanupItems,
  declareTables,
  absentTableName
} from '../../../src/helpers.js'

declareTables(hashTableDef, hashBTableDef)

const keysToCleanup = [
  { pk: { S: 'em-twi-dup' } },
  { pk: { S: 'em-twi-multi-1' } },
  { pk: { S: 'em-twi-multi-2' } },
  { pk: { S: 'em-twi-pos' } },
  { pk: { S: 'em-twi-pos-new' } },
]

afterAll(async () => {
  await cleanupItems(hashTableDef.name, keysToCleanup)
})

describe('TransactWriteItems — exact error messages', { tags: ['transactions', 'data-plane', 'negative-path'] }, () => {
  // An empty TransactItems is rejected by any target that implements the
  // operation, so this separates "not implemented" from "implemented".
  skipUnlessSupported(() => ddb.send(new TransactWriteItemsCommand({ TransactItems: [] })))

  it('empty TransactItems: full minimum-length error', async () => {
    // The same rollout as TransactGetItems' empty list. eu-north-1 and
    // ap-northeast-2 gave the validation framework's generic constraint message
    // first, and eu-west-2 switched to it on 2026-10-08, between two
    // ground-truth runs on main 30 minutes apart. The other 30 regions still
    // echo the empty list. The assertion accepts both exact messages and
    // nothing else until the regions settle.
    try {
      await ddb.send(new TransactWriteItemsCommand({ TransactItems: [] }))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect([
        "1 validation error detected: Value '[]' at 'transactItems' failed to satisfy constraint: Member must have length greater than or equal to 1",
        "1 validation error detected: Value at 'TransactItems' failed to satisfy constraint: Member must have length greater than or equal to 1",
      ]).toContain((err as DynamoDBServiceException).message)
    }
  })

  it('> 100 actions: anchored regex on the constraint phrase', async () => {
    // AWS echoes the entire TransactItems list into the validation message in
    // the same Java-toString shape used for BatchWriteItem. Pinning the dump
    // verbatim with .toBe() couples the assertion to SDK serialisation, which
    // has changed before. Anchored regex around the structural envelope
    // (`[<dump>]`) and the constraint phrase at the end lets the dump vary
    // without weakening what we actually care about.
    const items = Array.from({ length: 101 }, (_, i) => ({
      Put: {
        TableName: hashTableDef.name,
        Item: { pk: { S: `twi-${i}` } },
      },
    }))
    // The pattern spans both validation cohorts. eu-north-1 moved to the
    // framework's generic wording by the 2026-10-03 sweep and names the
    // constraint against the member instead of echoing the request; the
    // 100-action limit is what fires either way, which is all this
    // assertion claims. It stays a pattern rather than a registry row because
    // the old cohort's message embeds the whole request, per-run table name
    // included, so there is no byte-exact answer for a row to hold.
    const echoedRequest = `Value '\\[.+\\]' at 'transactItems'`
    const namedMember = `Value at 'TransactItems'`
    const expectedPattern = new RegExp(
      `^1 validation error detected: (?:${echoedRequest}|${namedMember}) failed to satisfy constraint: ` +
        `Member must have length less than or equal to 100$`,
      's',
    )
    try {
      await ddb.send(new TransactWriteItemsCommand({ TransactItems: items }))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toMatch(expectedPattern)
    }
  })

  it('duplicate target keys in same transaction: full multi-op error', async () => {
    try {
      await ddb.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: hashTableDef.name,
                Item: { pk: { S: 'em-twi-dup' } },
              },
            },
            {
              Put: {
                TableName: hashTableDef.name,
                Item: { pk: { S: 'em-twi-dup' } },
              },
            },
          ],
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Transaction request cannot include multiple operations on one item',
      )
    }
  })

  it('non-existent table: full ResourceNotFoundException message', async () => {
    try {
      await ddb.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: absentTableName('does_not_exist_em_twi'),
                Item: { pk: { S: 'x' } },
              },
            },
          ],
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ResourceNotFoundException)
      expect((err as ResourceNotFoundException).name).toBe(
        'ResourceNotFoundException',
      )
      expect((err as ResourceNotFoundException).message).toBe(
        'Requested resource not found',
      )
    }
  })

  it('two failing actions: multi-reason TransactionCanceledException', async () => {
    // Integration: both actions in the transaction violate their conditions.
    // The cancellation summary lists every action's reason code in order, so
    // we can build the expected message from the same array we cross-check
    // against `CancellationReasons[].Code` — fully deterministic, no regex.
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'em-twi-multi-1' }, attr1: { S: 'exists' } },
      }),
    )
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'em-twi-multi-2' }, attr1: { S: 'exists' } },
      }),
    )

    try {
      await ddb.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: hashTableDef.name,
                Item: { pk: { S: 'em-twi-multi-1' }, attr1: { S: 'over' } },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            {
              Put: {
                TableName: hashTableDef.name,
                Item: { pk: { S: 'em-twi-multi-2' }, attr1: { S: 'over' } },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
          ],
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionCanceledException)
      const txErr = err as TransactionCanceledException
      const expectedReasons = [
        'ConditionalCheckFailed',
        'ConditionalCheckFailed',
      ] as const
      expect(txErr.message).toBe(
        `Transaction cancelled, please refer cancellation reasons for specific reasons [${expectedReasons.join(', ')}]`,
      )
      expect(txErr.CancellationReasons?.map((r) => r.Code)).toEqual([
        ...expectedReasons,
      ])
    }
  })

  it('one passing, one failing: positional reason codes (None for the survivor)', async () => {
    // The cancellation summary reports a code per action *positionally* —
    // 'None' for actions that would have succeeded, the actual failure code
    // for actions that did not. Pin the full message and structure so the
    // suite catches emulators that emit a flat 'ConditionalCheckFailed' list
    // without per-action accounting.
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'em-twi-pos' }, attr1: { S: 'exists' } },
      }),
    )

    try {
      await ddb.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: hashTableDef.name,
                Item: { pk: { S: 'em-twi-pos-new' }, attr1: { S: 'fresh' } },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            {
              Put: {
                TableName: hashTableDef.name,
                Item: { pk: { S: 'em-twi-pos' }, attr1: { S: 'over' } },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
          ],
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionCanceledException)
      const txErr = err as TransactionCanceledException
      const expectedReasons = ['None', 'ConditionalCheckFailed'] as const
      expect(txErr.message).toBe(
        `Transaction cancelled, please refer cancellation reasons for specific reasons [${expectedReasons.join(', ')}]`,
      )
      expect(txErr.CancellationReasons?.map((r) => r.Code)).toEqual([
        ...expectedReasons,
      ])
      expect(txErr.CancellationReasons?.[1].Message).toBe(
        'The conditional request failed',
      )
    }
  })

  // Invalid table key value inside a transact Put/Update. The error shape
  // splits by fault, captured from real AWS eu-west-2:
  //   - wrong type / non-scalar: TransactionCanceledException, reason code
  //     'ValidationError', reason Message carrying the PutItem-style string;
  //   - empty string: top-level ValidationException (up-front input validation).
  // The secondary-index equivalents live in transactIndexKeys.test.ts.
  const expectCancelledReason = async (
    command: TransactWriteItemsCommand,
    reasonMessage: string,
  ) => {
    try {
      await ddb.send(command)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionCanceledException)
      const txErr = err as TransactionCanceledException
      const expectedReasons = ['ValidationError'] as const
      expect(txErr.message).toBe(
        `Transaction cancelled, please refer cancellation reasons for specific reasons [${expectedReasons.join(', ')}]`,
      )
      expect(txErr.CancellationReasons?.map((r) => r.Code)).toEqual([
        ...expectedReasons,
      ])
      expect(txErr.CancellationReasons?.[0]?.Message).toBe(reasonMessage)
    }
  }

  const expectTopLevelValidation = async (
    command: TransactWriteItemsCommand,
    message: string,
  ) => {
    try {
      await ddb.send(command)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(message)
    }
  }

  it('Put wrong-typed table key: cancelled with full ValidationError reason', async () => {
    await expectCancelledReason(
      new TransactWriteItemsCommand({
        TransactItems: [{ Put: { TableName: hashTableDef.name, Item: { pk: { N: '5' } } } }],
      }),
      'One or more parameter values were invalid: Type mismatch for key pk expected: S actual: N',
    )
  })

  it('Put non-scalar table key: cancelled with full ValidationError reason', async () => {
    await expectCancelledReason(
      new TransactWriteItemsCommand({
        TransactItems: [{ Put: { TableName: hashTableDef.name, Item: { pk: { L: [{ S: 'x' }] } } } }],
      }),
      'One or more parameter values were invalid: Type mismatch for key pk expected: S actual: L',
    )
  })

  it('Put empty-string table key: top-level ValidationException', async () => {
    await expectTopLevelValidation(
      new TransactWriteItemsCommand({
        TransactItems: [{ Put: { TableName: hashTableDef.name, Item: { pk: { S: '' } } } }],
      }),
      'One or more parameter values are not valid. The AttributeValue for a key attribute cannot contain an empty string value. Key: pk',
    )
  })

  // Exact messages for a malformed lookup Key on transact Update / Delete /
  // ConditionCheck (the key-only validation path). Four-region capture (2026-06-23),
  // all invariant, so rung 1 .toBe(). Empty string carries the same message as a Put
  // item key; wrong-type and non-scalar cancel with the schema-mismatch reason, NOT
  // the Put 'Type mismatch for key' form.
  const emptyKeyMsg = 'One or more parameter values are not valid. The AttributeValue for a key attribute cannot contain an empty string value. Key: pk'
  const schemaMismatchMsg = 'The provided key element does not match the schema'
  const cmd = (item: unknown) => new TransactWriteItemsCommand({ TransactItems: [item] as TransactWriteItem[] })
  const updKey = (key: unknown) => ({ Update: { TableName: hashTableDef.name, Key: { pk: key }, UpdateExpression: 'SET attr1 = :v', ExpressionAttributeValues: { ':v': { S: 'x' } } } })
  const delKey = (key: unknown) => ({ Delete: { TableName: hashTableDef.name, Key: { pk: key } } })
  const ccKey = (key: unknown) => ({ ConditionCheck: { TableName: hashTableDef.name, Key: { pk: key }, ConditionExpression: 'attribute_not_exists(pk)' } })

  it('Update empty-string Key: top-level empty-value message', () =>
    expectTopLevelValidation(cmd(updKey({ S: '' })), emptyKeyMsg))
  it('Delete empty-string Key: top-level empty-value message', () =>
    expectTopLevelValidation(cmd(delKey({ S: '' })), emptyKeyMsg))
  it('ConditionCheck empty-string Key: top-level empty-value message', () =>
    expectTopLevelValidation(cmd(ccKey({ S: '' })), emptyKeyMsg))

  it('Update wrong-typed Key: cancelled with schema-mismatch reason', () =>
    expectCancelledReason(cmd(updKey({ N: '5' })), schemaMismatchMsg))
  it('Update non-scalar Key: cancelled with schema-mismatch reason', () =>
    expectCancelledReason(cmd(updKey({ L: [{ S: 'x' }] })), schemaMismatchMsg))
  it('Delete wrong-typed Key: cancelled with schema-mismatch reason', () =>
    expectCancelledReason(cmd(delKey({ N: '5' })), schemaMismatchMsg))
  it('Delete non-scalar Key: cancelled with schema-mismatch reason', () =>
    expectCancelledReason(cmd(delKey({ L: [{ S: 'x' }] })), schemaMismatchMsg))
  it('ConditionCheck wrong-typed Key: cancelled with schema-mismatch reason', () =>
    expectCancelledReason(cmd(ccKey({ N: '5' })), schemaMismatchMsg))
  it('ConditionCheck non-scalar Key: cancelled with schema-mismatch reason', () =>
    expectCancelledReason(cmd(ccKey({ L: [{ S: 'x' }] })), schemaMismatchMsg))

  // Empty-binary key values mirror the empty-string cases: a top-level
  // ValidationException that hoists out of the transaction, never a cancellation
  // reason. Real AWS names the same message with 'binary' for 'string'.
  const emptyBinKeyMsg = 'One or more parameter values are not valid. The AttributeValue for a key attribute cannot contain an empty binary value. Key: pk'
  const emptyBin = { B: new Uint8Array([]) }
  const updKeyB = (key: unknown) => ({ Update: { TableName: hashBTableDef.name, Key: { pk: key }, UpdateExpression: 'SET attr1 = :v', ExpressionAttributeValues: { ':v': { S: 'x' } } } })
  const delKeyB = (key: unknown) => ({ Delete: { TableName: hashBTableDef.name, Key: { pk: key } } })
  const ccKeyB = (key: unknown) => ({ ConditionCheck: { TableName: hashBTableDef.name, Key: { pk: key }, ConditionExpression: 'attribute_not_exists(pk)' } })

  it('Put empty-binary item key: top-level empty-value message', () =>
    expectTopLevelValidation(cmd({ Put: { TableName: hashBTableDef.name, Item: { pk: emptyBin } } }), emptyBinKeyMsg))
  it('Update empty-binary Key: top-level empty-value message', () =>
    expectTopLevelValidation(cmd(updKeyB(emptyBin)), emptyBinKeyMsg))
  it('Delete empty-binary Key: top-level empty-value message', () =>
    expectTopLevelValidation(cmd(delKeyB(emptyBin)), emptyBinKeyMsg))
  it('ConditionCheck empty-binary Key: top-level empty-value message', () =>
    expectTopLevelValidation(cmd(ccKeyB(emptyBin)), emptyBinKeyMsg))

  // Request-level checks that run before any action does. Captured in
  // us-east-1 and eu-west-2, 2026-10-08 and 2026-10-09.
  it('Put malformed table name: top-level message naming the member', () =>
    expectTopLevelValidation(
      cmd({ Put: { TableName: 'bad!name', Item: { pk: { S: 'a' } } } }),
      "1 validation error detected: Value 'bad!name' at 'transactItems.1.member.put.tableName' failed to satisfy constraint: Member must satisfy regular expression pattern: [a-zA-Z0-9_.-]+",
    ))

  // The member path names the action's position and its type.
  const badName = (path: string) =>
    `1 validation error detected: Value 'bad!name' at 'transactItems.${path}.tableName' failed to satisfy constraint: Member must satisfy regular expression pattern: [a-zA-Z0-9_.-]+`

  it('Update malformed table name on the second action: top-level message naming the member', () =>
    expectTopLevelValidation(
      new TransactWriteItemsCommand({
        TransactItems: [
          { Put: { TableName: hashTableDef.name, Item: { pk: { S: 'em-twi-badname-first' } } } },
          { Update: { TableName: 'bad!name', Key: { pk: { S: 'a' } }, UpdateExpression: 'SET a = :a', ExpressionAttributeValues: { ':a': { S: 'x' } } } },
        ],
      }),
      badName('2.member.update'),
    ))

  it('Delete malformed table name: top-level message naming the member', () =>
    expectTopLevelValidation(cmd({ Delete: { TableName: 'bad!name', Key: { pk: { S: 'a' } } } }), badName('1.member.delete')))

  it('ConditionCheck malformed table name: top-level message naming the member', () =>
    expectTopLevelValidation(
      cmd({ ConditionCheck: { TableName: 'bad!name', Key: { pk: { S: 'a' } }, ConditionExpression: 'attribute_exists(pk)' } }),
      badName('1.member.conditionCheck'),
    ))

  it('Put empty ConditionExpression: top-level empty-expression message', () =>
    expectTopLevelValidation(
      cmd({ Put: { TableName: hashTableDef.name, Item: { pk: { S: 'em-twi-empty-put' } }, ConditionExpression: '' } }),
      'Invalid ConditionExpression: The expression can not be empty;',
    ))

  it('Delete empty ConditionExpression: top-level empty-expression message', () =>
    expectTopLevelValidation(
      cmd({ Delete: { TableName: hashTableDef.name, Key: { pk: { S: 'em-twi-empty-del' } }, ConditionExpression: '' } }),
      'Invalid ConditionExpression: The expression can not be empty;',
    ))

  it('ConditionCheck empty ConditionExpression: top-level empty-expression message', () =>
    expectTopLevelValidation(
      cmd({ ConditionCheck: { TableName: hashTableDef.name, Key: { pk: { S: 'em-twi-cc' } }, ConditionExpression: '' } }),
      'Invalid ConditionExpression: The expression can not be empty;',
    ))

  it('ConditionCheck malformed ConditionExpression: top-level syntax message', () =>
    expectTopLevelValidation(
      cmd({ ConditionCheck: { TableName: hashTableDef.name, Key: { pk: { S: 'em-twi-cc' } }, ConditionExpression: 'attribute_not_exists(' } }),
      'Invalid ConditionExpression: Syntax error; token: "<EOF>", near: "("',
    ))

  it('ConditionCheck unused ExpressionAttributeValues: top-level message', () =>
    expectTopLevelValidation(
      cmd({
        ConditionCheck: {
          TableName: hashTableDef.name,
          Key: { pk: { S: 'em-twi-cc' } },
          ConditionExpression: 'attribute_not_exists(pk)',
          ExpressionAttributeValues: { ':v': { S: 'x' } },
        },
      }),
      'Value provided in ExpressionAttributeValues unused in expressions: keys: {:v}',
    ))

  for (const [action, item] of [
    ['Put', { Put: { TableName: hashTableDef.name, Item: { pk: { S: 'em-twi-unused-put' } }, ConditionExpression: 'attribute_not_exists(pk)', ExpressionAttributeValues: { ':v': { S: 'x' } } } }],
    ['Update', { Update: { TableName: hashTableDef.name, Key: { pk: { S: 'em-twi-unused-upd' } }, UpdateExpression: 'SET a = :a', ExpressionAttributeValues: { ':a': { S: 'x' }, ':v': { S: 'x' } } } }],
    ['Delete', { Delete: { TableName: hashTableDef.name, Key: { pk: { S: 'em-twi-unused-del' } }, ConditionExpression: 'attribute_exists(pk)', ExpressionAttributeValues: { ':v': { S: 'x' } } } }],
  ] as const) {
    it(`${action} unused ExpressionAttributeValues: top-level message`, () =>
      expectTopLevelValidation(cmd(item), 'Value provided in ExpressionAttributeValues unused in expressions: keys: {:v}'))
  }

  it('unused value on the second action: nothing is written', async () => {
    const first = { pk: { S: 'em-twi-unused-first' } }
    await expectTopLevelValidation(
      new TransactWriteItemsCommand({
        TransactItems: [
          { Put: { TableName: hashTableDef.name, Item: first } },
          {
            ConditionCheck: {
              TableName: hashTableDef.name,
              Key: { pk: { S: 'em-twi-cc' } },
              ConditionExpression: 'attribute_not_exists(pk)',
              ExpressionAttributeValues: { ':v': { S: 'x' } },
            },
          },
        ],
      }),
      'Value provided in ExpressionAttributeValues unused in expressions: keys: {:v}',
    )
    const got = await ddb.send(new GetItemCommand({ TableName: hashTableDef.name, Key: first, ConsistentRead: true }))
    expect(got.Item).toBeUndefined()
    await cleanupItems(hashTableDef.name, [first])
  })

  it('action with no operation: top-level message', async () => {
    // Regional while the validation framework rolls out: eu-west-2 names the
    // constraint against the list, us-east-1 keeps its own sentence. Both are
    // exact; nothing else passes.
    try {
      await ddb.send(new TransactWriteItemsCommand({ TransactItems: [{}] as TransactWriteItem[] }))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect([
        "1 validation error detected: Value '' at 'transactItems' failed to satisfy constraint: TransactWriteRequest should contain Delete or Put or Update or ConditionCheck",
        'Invalid Request: TransactWriteRequest should contain Delete or Put or Update request',
      ]).toContain((err as DynamoDBServiceException).message)
    }
  })
})
