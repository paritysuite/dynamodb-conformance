import { GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import {
  itemSizeTableDef,
  cleanupItems,
  declareTables,
  expectDynamoError,
} from '../../../src/helpers.js'
import {
  CAPTURED_NUMBER_BYTES,
  MAX_ITEM_BYTES,
  asciiOfBytes,
  itemBytes,
  utf8Bytes,
} from '../../../src/item-size.js'

declareTables(itemSizeTableDef)

// What a number costs, to the byte.
//
// The suite has never had an assertion on this. Consumed capacity is 1KB-granular
// and far too coarse to see one number's cost, so a target sizing a number by its
// string length, or at a fixed width, passes every capacity test in the suite
// while computing a very different item size — and therefore a different 400KB
// boundary. With thousands of numbers in an item, a small per-number error
// crosses the limit in either direction.
//
// The instrument is the gate, which resolves to the byte (see
// tests/tier3/limits/itemSize.test.ts). Each literal gets one item built to
// exactly 409,600 on the captured cost and one a byte over: accepted and refused
// is the assertion, with no bisection and two requests per literal. The pair
// discriminates both ways. Over-charge the number by a byte and the first item
// measures 409,601 and is refused; under-charge it and the second measures
// 409,600 and is accepted.
//
// The rule the figures below demonstrate:
//
//   1 + ceil(integer significant digits / 2) + ceil(fraction significant digits / 2)
//     + 1 if negative
//
// over the value with leading and trailing zeros trimmed. The AWS developer
// guide's version ("1 byte per two significant digits plus 1 byte") is wrong in
// two ways and an implementation written from it lands on exactly those: it
// rounds down where AWS rounds up, and it misses significant digits straddling
// the decimal point, which are counted in two halves and so cost an extra byte.
// `3.14159` costs 5 where the documented rule predicts 4, and the integer
// `123456` with the same digit count costs 4.
//
// Captured against eu-west-2 on 2026-08-18.
const TABLE = itemSizeTableDef.name
const PUT_WORDING = 'Item size has exceeded the maximum allowed size'
const PREFIX = 'lim-nbs-'
const keysToClean: Record<string, AttributeValue>[] = []

afterAll(async () => {
  await cleanupItems(TABLE, keysToClean)
})

function key(id: string) {
  const k = { pk: { S: `${PREFIX}${id}` } }
  keysToClean.push(k)
  return k
}

/**
 * `{pk, n: <literal>, p: <padding>}` measuring exactly `total` bytes, on the
 * assumption that the number costs `numberCost`.
 *
 * The padding is computed from the captured figure rather than from
 * `numberBytes`, so this asserts AWS against the capture rather than against the
 * suite's own formula. `itemBytes` here only ever sees string values.
 */
function itemForNumber(
  k: Record<string, AttributeValue>,
  literal: string,
  numberCost: number,
  total: number,
): Record<string, AttributeValue> {
  const padding = total - itemBytes(k) - utf8Bytes('n') - numberCost - utf8Bytes('p')
  if (padding < 0) throw new Error(`${literal} leaves no room for padding in ${total} bytes`)
  return { ...k, n: { N: literal }, p: { S: asciiOfBytes(padding) } }
}

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe("A number's byte cost", { tags: ['put-item', 'data-plane'] }, () => {
  // Titles carry the figure so a failure names the literal and the cost it was
  // measured at, rather than an index. The quotes are written by hand because
  // the title is part of the test ID, and Vitest 5 stopped quoting string
  // placeholders.
  it.each(
    CAPTURED_NUMBER_BYTES.map(([literal, bytes]) => ({
      literal,
      bytes,
      cost: `${bytes} byte${bytes === 1 ? '' : 's'}`,
    })),
  )("sizes '$literal' at '$cost'", async ({ literal, bytes }) => {
    const accepted = key(`at-${literal}`)
    await ddb.send(new PutItemCommand({
      TableName: TABLE,
      Item: itemForNumber(accepted, literal, bytes, MAX_ITEM_BYTES),
    }))

    await expectDynamoError(
      () => ddb.send(new PutItemCommand({
        TableName: TABLE,
        Item: itemForNumber(key(`over-${literal}`), literal, bytes, MAX_ITEM_BYTES + 1),
      })),
      'ValidationException',
      PUT_WORDING,
    )
  })
})

// The size follows the significant digits; the stored form is the expanded
// decimal. An engine conflating the two applies the formula to `1E125`'s
// 126-digit expansion and charges 64 bytes where AWS charges 2.
describe('A number is stored expanded and sized by its significant digits', { tags: ['put-item', 'data-plane'] }, () => {
  async function roundTrip(id: string, literal: string): Promise<string> {
    const k = key(`rt-${id}`)
    await ddb.send(new PutItemCommand({ TableName: TABLE, Item: { ...k, n: { N: literal } } }))
    const got = await ddb.send(new GetItemCommand({
      TableName: TABLE, Key: k, ConsistentRead: true,
    }))
    return got.Item!.n.N!
  }

  it('trims the zeros it does not count', async () => {
    expect(await roundTrip('trim', '0042.1200')).toBe('42.12')
  })

  it('expands an exponent it does not count', async () => {
    const stored = await roundTrip('exp', '1E125')
    expect(stored).toHaveLength(126)
    expect(stored).toBe(`1${'0'.repeat(125)}`)
  })

  it('costs the same either way: the expanded form is not what is measured', async () => {
    // 1E125 stores as 126 digits and costs 2 bytes, the same as the literal `1`.
    const k = key('exp-cost')
    await ddb.send(new PutItemCommand({
      TableName: TABLE,
      Item: itemForNumber(k, '1E125', 2, MAX_ITEM_BYTES),
    }))
    await expectDynamoError(
      () => ddb.send(new PutItemCommand({
        TableName: TABLE,
        Item: itemForNumber(key('exp-cost-over'), '1E125', 2, MAX_ITEM_BYTES + 1),
      })),
      'ValidationException',
      PUT_WORDING,
    )
  })
})
