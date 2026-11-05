import {
  DeleteItemCommand,
  PutItemCommand,
  ScanCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  DynamoDBServiceException,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { skipUnlessSupported } from '../../../src/infra.js'
import { absentTableName, withBody } from '../../../src/helpers.js'

// Which error DynamoDB reports when a request carries a value nested past its
// limits and something else is wrong as well. Captured in eu-west-2 and
// us-east-1, 2026-10-09; the Scan and transaction cases also in us-east-2,
// us-west-2, eu-west-1, eu-central-1, eu-north-1, ap-southeast-2,
// ap-northeast-1 and ca-central-1. Every table here is absent: each answer
// comes before the table is looked up.
//
// Depth counts single-key map wrappers around a string leaf, as in
// tests/tier3/limits/nestingDepth.test.ts. 33 and 40 are past the 32-level
// document limit; 63 and 100 are past the point (about 62 levels) where the
// single-item operations read the request differently and answer in an older
// form.

const NEST =
  'Nesting Levels have exceeded supported limits: Attributes in the item have nested levels beyond supported limit'
const nestForKey = (key: string) => `ExpressionAttributeValues contains invalid value: ${NEST} for key ${key}`

// The older layer's member errors, and the envelope that joins them.
const enumMember = (value: string, at: string, set: string) =>
  `Value '${value}' at '${at}' failed to satisfy constraint: Member must satisfy enum value set: [${set}]`
const RV = (value = 'BOGUS') => enumMember(value, 'returnValues', 'ALL_NEW, UPDATED_OLD, ALL_OLD, NONE, UPDATED_NEW')
const CO = enumMember('XOR', 'conditionalOperator', 'OR, AND')
const RCC = (value = 'BOGUS') => enumMember(value, 'returnConsumedCapacity', 'INDEXES, TOTAL, NONE')
const RICM = enumMember('BOGUS', 'returnItemCollectionMetrics', 'SIZE, NONE')
const RVOCCF = enumMember('BOGUS', 'returnValuesOnConditionCheckFailure', 'ALL_OLD, NONE')
const missing = (at: string) => `Value null at '${at}' failed to satisfy constraint: Member must not be null`
const detected = (...errors: string[]) =>
  `${errors.length} validation error${errors.length === 1 ? '' : 's'} detected: ${errors.join('; ')}`

const XOR_OLDER = detected(CO)
const RV_OLDER = detected(RV())
const SYNTAX = 'Invalid ConditionExpression: Syntax error; token: "=", near: "= = b"'
const EMPTY_NAME = 'Empty attribute name'

const A = absentTableName('deep_order_absent')

function deep(depth: number): AttributeValue {
  let v: AttributeValue = { S: 'leaf' }
  for (let i = 0; i < depth; i++) v = { M: { n: v } }
  return v
}

const S = (s: string): AttributeValue => ({ S: s })
const key = (pk: AttributeValue) => ({ pk, sk: S('1') })

async function refusal(send: () => Promise<unknown>): Promise<string> {
  try {
    await send()
  } catch (e: unknown) {
    expect(e).toBeInstanceOf(DynamoDBServiceException)
    const err = e as DynamoDBServiceException
    expect(err.name).toBe('ValidationException')
    return err.message
  }
  expect.unreachable('should have thrown')
  return ''
}

describe('Deep requests — legacy conditions', { tags: ['put-item', 'update-item', 'scan', 'legacy', 'data-plane', 'negative-path'] }, () => {
  // Past the second limit, PutItem and UpdateItem check ConditionalOperator in
  // its older enum form, and that check comes before the depth of an
  // Expected value. At 33 and 40 levels the newer `[ALL, OR]` form is
  // reported instead (both regions).
  it('PutItem reports XOR in the older enum wording ahead of an Expected value nested 100 levels', async () => {
    const message = await refusal(() =>
      ddb.send(
        new PutItemCommand({
          TableName: A,
          Item: key(S('a')),
          Expected: { a: { Value: deep(100) }, b: { Exists: false } },
          ConditionalOperator: 'XOR' as any,
        }),
      ),
    )
    expect(message).toBe(XOR_OLDER)
  })

  it('UpdateItem reports XOR in the older enum wording ahead of an Expected value nested 100 levels', async () => {
    const message = await refusal(() =>
      ddb.send(
        new UpdateItemCommand({
          TableName: A,
          Key: key(S('a')),
          AttributeUpdates: { x: { Action: 'PUT', Value: S('1') } },
          Expected: { a: { Value: deep(100) }, b: { Exists: false } },
          ConditionalOperator: 'XOR' as any,
        }),
      ),
    )
    expect(message).toBe(XOR_OLDER)
  })

  it('Scan with one ScanFilter condition nested 40 levels and ConditionalOperator AND', async () => {
    // Split by validation layer: seven of the ten regions probed report the
    // depth first (us-east-1, us-east-2, us-west-2, eu-west-1, eu-north-1,
    // ap-northeast-1, ca-central-1); eu-west-2, eu-central-1 and
    // ap-southeast-2 report the ConditionalOperator misuse first. Exactly those
    // two answers.
    const message = await refusal(() =>
      ddb.send(
        new ScanCommand({
          TableName: A,
          ScanFilter: { a: { ComparisonOperator: 'EQ', AttributeValueList: [deep(40)] } },
          ConditionalOperator: 'AND',
        }),
      ),
    )
    expect([NEST, 'ConditionalOperator can only be used when Filter or Expected has two or more elements']).toContain(message)
  })
})

describe('Deep requests — TransactWriteItems action order', { tags: ['transactions', 'data-plane', 'negative-path'] }, () => {
  // An empty TransactItems is rejected by any target that implements the
  // operation, so this separates "not implemented" from "implemented".
  skipUnlessSupported(() => ddb.send(new TransactWriteItemsCommand({ TransactItems: [] })))

  // TransactWriteItems checks its actions one at a time, in request order, and
  // reports the first problem it meets: a later action's error never beats an
  // earlier action's, whatever kind either is. All ten regions probed agree
  // unless a test says otherwise.
  const send = (TransactItems: any[]) => () => ddb.send(new TransactWriteItemsCommand({ TransactItems }))

  it('reports a Put item nested 40 levels before an empty attribute name in a later Put', async () => {
    const message = await refusal(
      send([
        { Put: { TableName: A, Item: { ...key(S('b')), d: deep(40) } } },
        { Put: { TableName: A, Item: { ...key(S('a')), '': S('x') } } },
      ]),
    )
    expect(message).toBe(NEST)
  })

  it('reports an empty attribute name before a Put item nested 100 levels in a later Put', async () => {
    const message = await refusal(
      send([
        { Put: { TableName: A, Item: { ...key(S('a')), '': S('x') } } },
        { Put: { TableName: A, Item: { ...key(S('b')), d: deep(100) } } },
      ]),
    )
    expect(message).toBe(EMPTY_NAME)
  })

  it('reports a top-level empty attribute name before a value nested 100 levels in the same item, in either order', async () => {
    const first = await refusal(send([{ Put: { TableName: A, Item: { ...key(S('a')), '': S('x'), d: deep(100) } } }]))
    const second = await refusal(send([{ Put: { TableName: A, Item: { ...key(S('a')), d: deep(100), '': S('x') } } }]))
    expect([first, second]).toEqual([EMPTY_NAME, EMPTY_NAME])
  })

  it('refuses a value nested 40 levels beside an empty map key inside the same item', async () => {
    // All ten regions probed on 2026-10-09 reported the depth. On 2026-10-22
    // eu-west-2 gave the depth on some runs and the empty map key on others,
    // for the same request, so both pass until it settles on one.
    const message = await refusal(
      send([{ Put: { TableName: A, Item: { ...key(S('a')), m: { M: { '': S('x') } }, d: deep(40) } } }]),
    )
    expect([NEST, EMPTY_NAME]).toContain(message)
  })

  it('reports an empty attribute name before a later ConditionCheck value nested 100 levels', async () => {
    const message = await refusal(
      send([
        { Put: { TableName: A, Item: { ...key(S('a')), '': S('x') } } },
        {
          ConditionCheck: {
            TableName: A,
            Key: key(S('b')),
            ConditionExpression: 'd = :deep',
            ExpressionAttributeValues: { ':deep': deep(100) },
          },
        },
      ]),
    )
    expect(message).toBe(EMPTY_NAME)
  })

  it('reports an earlier ConditionCheck value nested 40 levels before a later empty attribute name', async () => {
    // Regional wording: eight of the ten regions probed name the value's key;
    // eu-west-2 and eu-north-1 give the nesting message bare. Exactly those two answers.
    const message = await refusal(
      send([
        {
          ConditionCheck: {
            TableName: A,
            Key: key(S('b')),
            ConditionExpression: 'd = :deep',
            ExpressionAttributeValues: { ':deep': deep(40) },
          },
        },
        { Put: { TableName: A, Item: { ...key(S('a')), '': S('x') } } },
      ]),
    )
    expect([nestForKey(':deep'), NEST]).toContain(message)
  })

  it('reports an earlier Update value nested 40 levels before a later empty attribute name', async () => {
    // Same regional wording as the ConditionCheck case above.
    const message = await refusal(
      send([
        {
          Update: {
            TableName: A,
            Key: key(S('a')),
            UpdateExpression: 'SET d = :deep',
            ExpressionAttributeValues: { ':deep': deep(40) },
          },
        },
        { Put: { TableName: A, Item: { ...key(S('b')), '': S('x') } } },
      ]),
    )
    expect([nestForKey(':deep'), NEST]).toContain(message)
  })

  it('reports a Delete key nested 40 levels before a later Put condition syntax error', async () => {
    const message = await refusal(
      send([
        { Delete: { TableName: A, Key: key(deep(40)) } },
        { Put: { TableName: A, Item: key(S('a')), ConditionExpression: 'a = = b' } },
      ]),
    )
    expect(message).toBe(NEST)
  })

  it('reports a ConditionCheck key nested 40 levels before a later Update unused value', async () => {
    const message = await refusal(
      send([
        { ConditionCheck: { TableName: A, Key: key(deep(40)), ConditionExpression: 'attribute_exists(a)' } },
        {
          Update: {
            TableName: A,
            Key: key(S('a')),
            UpdateExpression: 'SET a = :v',
            ExpressionAttributeValues: { ':v': S('x'), ':u': S('y') },
          },
        },
      ]),
    )
    expect(message).toBe(NEST)
  })

  it('reports a Put condition syntax error before a later Delete key nested 100 levels', async () => {
    const message = await refusal(
      send([
        { Put: { TableName: A, Item: key(S('a')), ConditionExpression: 'a = = b' } },
        { Delete: { TableName: A, Key: key(deep(100)) } },
      ]),
    )
    expect(message).toBe(SYNTAX)
  })

  it('reports a condition syntax error before the same Delete key nested 100 levels', async () => {
    const message = await refusal(
      send([{ Delete: { TableName: A, Key: key(deep(100)), ConditionExpression: 'a = = b' } }]),
    )
    expect(message).toBe(SYNTAX)
  })

  it('reports an oversized condition before the same Delete key nested 100 levels', async () => {
    // 4,109 characters: 'a = :v' and 373 repeats of ' AND a = :v'.
    const condition = 'a = :v' + ' AND a = :v'.repeat(373)
    const message = await refusal(
      send([
        {
          Delete: {
            TableName: A,
            Key: key(deep(100)),
            ConditionExpression: condition,
            ExpressionAttributeValues: { ':v': S('x') },
          },
        },
      ]),
    )
    expect(message).toBe('Invalid ConditionExpression: Expression size has exceeded the maximum allowed size; expression size: 4109')
  })

  it('reports an oversized UpdateExpression before a later ConditionCheck key nested 100 levels', async () => {
    const message = await refusal(
      send([
        {
          Update: {
            TableName: A,
            Key: key(S('a')),
            UpdateExpression: 'SET ' + Array.from({ length: 500 }, (_, i) => `a${i} = :v`).join(', '),
            ExpressionAttributeValues: { ':v': S('x') },
          },
        },
        { ConditionCheck: { TableName: A, Key: key(deep(100)), ConditionExpression: 'attribute_exists(a)' } },
      ]),
    )
    expect(message).toBe('Invalid UpdateExpression: Expression size has exceeded the maximum allowed size;')
  })

  it('reports an unused value before a later ConditionCheck key nested 100 levels', async () => {
    const message = await refusal(
      send([
        {
          Update: {
            TableName: A,
            Key: key(S('a')),
            UpdateExpression: 'SET a = :v',
            ExpressionAttributeValues: { ':v': S('x'), ':u': S('y') },
          },
        },
        { ConditionCheck: { TableName: A, Key: key(deep(100)), ConditionExpression: 'attribute_exists(a)' } },
      ]),
    )
    expect(message).toBe('Value provided in ExpressionAttributeValues unused in expressions: keys: {:u}')
  })
})

describe('Deep requests — DeleteItem ReturnValues', { tags: ['delete-item', 'data-plane', 'negative-path'] }, () => {
  // Past the second limit DeleteItem reads ReturnValues in its older form, as
  // PutItem and UpdateItem do: an unknown value gets the per-value enum
  // message, and UPDATED_NEW gets the bare "ALL_OLD or NONE" message, both
  // ahead of the nesting error. At 40 levels the newer generic form stays.
  const cond = (depth: number) => ({
    ConditionExpression: '#d = :deep',
    ExpressionAttributeNames: { '#d': 'd' },
    ExpressionAttributeValues: { ':deep': deep(depth) },
  })

  it('refuses an unknown ReturnValues in the older wording when the condition value is nested 63 levels', async () => {
    const message = await refusal(() =>
      ddb.send(new DeleteItemCommand({ TableName: A, Key: key(S('a')), ...cond(63), ReturnValues: 'BOGUS' as any })),
    )
    expect(message).toBe(RV_OLDER)
  })

  it('refuses an unknown ReturnValues in the older wording when an Expected value is nested 63 levels', { tags: ['legacy'] }, async () => {
    const message = await refusal(() =>
      ddb.send(
        new DeleteItemCommand({ TableName: A, Key: key(S('a')), Expected: { d: { Value: deep(63) } }, ReturnValues: 'BOGUS' as any }),
      ),
    )
    expect(message).toBe(RV_OLDER)
  })

  it('refuses an unknown ReturnValues in the older wording when the key is nested 100 levels', async () => {
    const message = await refusal(() =>
      ddb.send(new DeleteItemCommand({ TableName: A, Key: key(deep(100)), ReturnValues: 'BOGUS' as any })),
    )
    expect(message).toBe(RV_OLDER)
  })

  it('refuses UPDATED_NEW with the bare ReturnValues message ahead of a condition value nested 100 levels', async () => {
    const message = await refusal(() =>
      ddb.send(new DeleteItemCommand({ TableName: A, Key: key(S('a')), ...cond(100), ReturnValues: 'UPDATED_NEW' })),
    )
    expect(message).toBe('ReturnValues can only be ALL_OLD or NONE')
  })
})

describe('Deep writes list every bad member in order', { tags: ['put-item', 'update-item', 'delete-item', 'legacy', 'data-plane', 'negative-path'] }, () => {
  // Captured in 33 regions, 2026-11-05; every region gives the same answers.
  //
  // With an Expected value nested 100 levels, PutItem, UpdateItem and
  // DeleteItem are read by the older layer, which lists every bad member in a
  // fixed order per operation and joins them under one envelope:
  //   PutItem:    returnValues, conditionalOperator, item, returnValuesOnConditionCheckFailure,
  //               returnConsumedCapacity, returnItemCollectionMetrics
  //   UpdateItem: returnConsumedCapacity, returnValues, conditionalOperator,
  //               returnValuesOnConditionCheckFailure, returnItemCollectionMetrics, key
  //   DeleteItem: returnValues, conditionalOperator, returnValuesOnConditionCheckFailure,
  //               returnConsumedCapacity, returnItemCollectionMetrics, key
  // The depth itself is never reported while a member is wrong.
  const EXPECTED = { data: { Value: deep(100) }, other: { Value: S('a') } }
  const ALL_BAD = {
    ConditionalOperator: 'XOR',
    ReturnValues: 'BOGUS',
    ReturnConsumedCapacity: 'BOGUS',
    ReturnItemCollectionMetrics: 'BOGUS',
    ReturnValuesOnConditionCheckFailure: 'BOGUS',
  } as any
  const put = (input: Record<string, unknown>) => () =>
    ddb.send(new PutItemCommand({ TableName: A, Item: key(S('a')), Expected: EXPECTED, ...input } as any))
  const update = (input: Record<string, unknown>) => () =>
    ddb.send(new UpdateItemCommand({ TableName: A, Key: key(S('a')), Expected: EXPECTED, ...input } as any))
  const del = (input: Record<string, unknown>) => () =>
    ddb.send(new DeleteItemCommand({ TableName: A, Key: key(S('a')), Expected: EXPECTED, ...input } as any))

  describe('PutItem', () => {
    it('joins a bad ReturnValues and XOR', async () => {
      expect(await refusal(put({ ConditionalOperator: 'XOR', ReturnValues: 'BOGUS' }))).toBe(detected(RV(), CO))
    })

    it('lists ReturnValues, XOR, then a bad ReturnConsumedCapacity', async () => {
      const message = await refusal(put({ ConditionalOperator: 'XOR', ReturnValues: 'BOGUS', ReturnConsumedCapacity: 'BOGUS' }))
      expect(message).toBe(detected(RV(), CO, RCC()))
    })

    it('lists ReturnValues, XOR, then a bad ReturnItemCollectionMetrics', async () => {
      const message = await refusal(put({ ConditionalOperator: 'XOR', ReturnValues: 'BOGUS', ReturnItemCollectionMetrics: 'BOGUS' }))
      expect(message).toBe(detected(RV(), CO, RICM))
    })

    it('lists ReturnValues then ReturnConsumedCapacity without XOR', async () => {
      const message = await refusal(put({ ReturnValues: 'BOGUS', ReturnConsumedCapacity: 'BOGUS' }))
      expect(message).toBe(detected(RV(), RCC()))
    })

    it('leaves a valid ReturnValues out of the list', async () => {
      const message = await refusal(put({ ConditionalOperator: 'XOR', ReturnValues: 'NONE', ReturnConsumedCapacity: 'BOGUS' }))
      expect(message).toBe(detected(CO, RCC()))
    })

    it('lists all five bad members in order', async () => {
      expect(await refusal(put(ALL_BAD))).toBe(detected(RV(), CO, RVOCCF, RCC(), RICM))
    })

    it('lists a missing Item third among all five bad members', async () => {
      const message = await refusal(() =>
        ddb.send(new PutItemCommand({ TableName: A, Expected: EXPECTED, ...ALL_BAD } as any)),
      )
      expect(message).toBe(detected(RV(), CO, missing('item'), RVOCCF, RCC(), RICM))
    })

    it('reads a null Item as missing', async () => {
      const body = { TableName: A, Item: null, Expected: EXPECTED, ReturnValues: 'BOGUS' }
      const message = await refusal(() => ddb.send(withBody(new PutItemCommand({ TableName: A, Item: key(S('a')) }), body)))
      expect(message).toBe(detected(RV(), missing('item')))
    })
  })

  describe('UpdateItem', () => {
    it('joins a bad ReturnValues and XOR', async () => {
      expect(await refusal(update({ ConditionalOperator: 'XOR', ReturnValues: 'BOGUS' }))).toBe(detected(RV(), CO))
    })

    it('lists a bad ReturnConsumedCapacity ahead of ReturnValues and XOR', async () => {
      const message = await refusal(update({ ConditionalOperator: 'XOR', ReturnValues: 'BOGUS', ReturnConsumedCapacity: 'BOGUS' }))
      expect(message).toBe(detected(RCC(), RV(), CO))
    })

    it('lists ReturnValues, XOR, then a bad ReturnItemCollectionMetrics', async () => {
      const message = await refusal(update({ ConditionalOperator: 'XOR', ReturnValues: 'BOGUS', ReturnItemCollectionMetrics: 'BOGUS' }))
      expect(message).toBe(detected(RV(), CO, RICM))
    })

    it('lists ReturnConsumedCapacity, ReturnValues, XOR, then ReturnItemCollectionMetrics', async () => {
      const message = await refusal(
        update({ ConditionalOperator: 'XOR', ReturnValues: 'BOGUS', ReturnConsumedCapacity: 'BOGUS', ReturnItemCollectionMetrics: 'BOGUS' }),
      )
      expect(message).toBe(detected(RCC(), RV(), CO, RICM))
    })

    it('lists all five bad members in order', async () => {
      expect(await refusal(update(ALL_BAD))).toBe(detected(RCC(), RV(), CO, RVOCCF, RICM))
    })

    it('lists a missing Key last among all five bad members', async () => {
      const message = await refusal(() =>
        ddb.send(new UpdateItemCommand({ TableName: A, Expected: EXPECTED, ...ALL_BAD } as any)),
      )
      expect(message).toBe(detected(RCC(), RV(), CO, RVOCCF, RICM, missing('key')))
    })

    it('lists a missing Key after ReturnValues and XOR', async () => {
      const message = await refusal(() =>
        ddb.send(new UpdateItemCommand({ TableName: A, Expected: EXPECTED, ConditionalOperator: 'XOR', ReturnValues: 'BOGUS' } as any)),
      )
      expect(message).toBe(detected(RV(), CO, missing('key')))
    })

    it('reads a null Key as missing', async () => {
      const body = { TableName: A, Key: null, Expected: EXPECTED, ConditionalOperator: 'XOR', ReturnValues: 'BOGUS' }
      const message = await refusal(() => ddb.send(withBody(new UpdateItemCommand({ TableName: A, Key: key(S('a')) }), body)))
      expect(message).toBe(detected(RV(), CO, missing('key')))
    })

    it('keeps the envelope for a bad ReturnConsumedCapacity alone', async () => {
      expect(await refusal(update({ ReturnConsumedCapacity: 'BOGUS' }))).toBe(detected(RCC()))
    })

    it('keeps the envelope for a bad ReturnValuesOnConditionCheckFailure alone', async () => {
      expect(await refusal(update({ ReturnValuesOnConditionCheckFailure: 'BOGUS' }))).toBe(detected(RVOCCF))
    })

    it('treats a value that reads like an error header as a plain value', async () => {
      const value = '1 validation error detected: z'
      expect(await refusal(update({ ReturnConsumedCapacity: value }))).toBe(detected(RCC(value)))
    })
  })

  describe('DeleteItem', () => {
    it('joins a bad ReturnValues and XOR', async () => {
      expect(await refusal(del({ ConditionalOperator: 'XOR', ReturnValues: 'BOGUS' }))).toBe(detected(RV(), CO))
    })

    it('lists ReturnValues, XOR, then a bad ReturnConsumedCapacity', async () => {
      const message = await refusal(del({ ConditionalOperator: 'XOR', ReturnValues: 'BOGUS', ReturnConsumedCapacity: 'BOGUS' }))
      expect(message).toBe(detected(RV(), CO, RCC()))
    })

    it('lists ReturnValues, XOR, then a bad ReturnItemCollectionMetrics', async () => {
      const message = await refusal(del({ ConditionalOperator: 'XOR', ReturnValues: 'BOGUS', ReturnItemCollectionMetrics: 'BOGUS' }))
      expect(message).toBe(detected(RV(), CO, RICM))
    })

    it('lists ReturnValues, XOR, ReturnConsumedCapacity, then ReturnItemCollectionMetrics', async () => {
      const message = await refusal(
        del({ ConditionalOperator: 'XOR', ReturnValues: 'BOGUS', ReturnConsumedCapacity: 'BOGUS', ReturnItemCollectionMetrics: 'BOGUS' }),
      )
      expect(message).toBe(detected(RV(), CO, RCC(), RICM))
    })

    it('lists ReturnValues, XOR, then a bad ReturnValuesOnConditionCheckFailure', async () => {
      const message = await refusal(
        del({ ConditionalOperator: 'XOR', ReturnValues: 'BOGUS', ReturnValuesOnConditionCheckFailure: 'BOGUS' }),
      )
      expect(message).toBe(detected(RV(), CO, RVOCCF))
    })

    it('lists all five bad members in order', async () => {
      expect(await refusal(del(ALL_BAD))).toBe(detected(RV(), CO, RVOCCF, RCC(), RICM))
    })

    it('lists a missing Key last among all five bad members', async () => {
      const message = await refusal(() =>
        ddb.send(new DeleteItemCommand({ TableName: A, Expected: EXPECTED, ...ALL_BAD } as any)),
      )
      expect(message).toBe(detected(RV(), CO, RVOCCF, RCC(), RICM, missing('key')))
    })

    it('reads a null Key as missing', async () => {
      const body = { TableName: A, Key: null, Expected: EXPECTED, ConditionalOperator: 'XOR' }
      const message = await refusal(() => ddb.send(withBody(new DeleteItemCommand({ TableName: A, Key: key(S('a')) }), body)))
      expect(message).toBe(detected(CO, missing('key')))
    })

    it('reports XOR alone ahead of the nesting error', async () => {
      expect(await refusal(del({ ConditionalOperator: 'XOR' }))).toBe(detected(CO))
    })

    it('reports only XOR beside a ReturnValues of ALL_NEW', async () => {
      expect(await refusal(del({ ConditionalOperator: 'XOR', ReturnValues: 'ALL_NEW' }))).toBe(detected(CO))
    })

    it('drops a ReturnValues of ALL_NEW beside a bad ReturnConsumedCapacity', async () => {
      expect(await refusal(del({ ReturnValues: 'ALL_NEW', ReturnConsumedCapacity: 'BOGUS' }))).toBe(detected(RCC()))
    })

    it('keeps a value holding "; " as one error', async () => {
      const message = await refusal(del({ ConditionalOperator: 'XOR', ReturnValues: 'A; B', ReturnConsumedCapacity: 'BOGUS' }))
      expect(message).toBe(detected(RV('A; B'), CO, RCC()))
    })
  })
})
