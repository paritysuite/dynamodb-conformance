import {
  CreateTableCommand,
  SearchVectorsCommand,
  DynamoDBServiceException,
  type SearchVectorsCommandInput,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { absentTableName, uniqueTableName, deleteTable } from '../../../src/helpers.js'
import {
  skipUnlessVectorSearch,
  supportsVectorSearch,
  waitForVectorIndexSearchable,
} from '../../../src/vector.js'

// Exact SearchVectors rejection messages, characterised against real DynamoDB
// in eu-west-2 (2026-08-11, issue #125). Two observations that diverge from
// the AWS documentation are pinned as observed:
//
// - The TopK message embeds the offending value and the range; the docs quote
//   only the leading fragment.
// - The comparator message carries an "Invalid SearchConditionExpression: "
//   prefix the docs omit, and it fires for non-equality operators on BOTH
//   element kinds. The developer guide (equality only, everywhere) wins over
//   the API reference's claim that INLINE_FILTER attributes accept comparison
//   and range operators.

const tableName = uniqueTableName('vec_smsg')
const vec = (...ns: number[]) => ns.map((n) => ({ N: String(n) }))

async function expectExactRejection(
  input: SearchVectorsCommandInput,
  message: string,
): Promise<void> {
  try {
    await ddb.send(new SearchVectorsCommand(input))
    expect.unreachable('should have thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(DynamoDBServiceException)
    expect((err as DynamoDBServiceException).name).toBe('ValidationException')
    expect((err as DynamoDBServiceException).message).toBe(message)
  }
}

describe('SearchVectors — exact error messages', { tags: ['search-vectors', 'data-plane', 'vector', 'negative-path'] }, () => {
  skipUnlessVectorSearch()

  let created = false

  beforeAll(async () => {
    if (!(await supportsVectorSearch())) return
    // Registered before the create so a partial setup still gets torn down.
    created = true
    await ddb.send(
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'tenant', AttributeType: 'S' },
          { AttributeName: 'category', AttributeType: 'S' },
        ],
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
        VectorIndexes: [
          {
            IndexName: 'plain',
            VectorAttribute: { AttributeName: 'embedding' },
            Dimensions: 3,
            DistanceFunction: 'COSINE',
            Projection: { ProjectionType: 'ALL' },
          },
          {
            IndexName: 'schema',
            VectorAttribute: { AttributeName: 'embedding' },
            Dimensions: 3,
            DistanceFunction: 'COSINE',
            Projection: { ProjectionType: 'ALL' },
            SearchSchema: [
              { AttributeName: 'tenant', SearchSchemaElementType: 'HASH' },
              { AttributeName: 'category', SearchSchemaElementType: 'INLINE_FILTER' },
            ],
          },
        ],
      }),
    )
    // Searchable, not merely ACTIVE. Every case below asserts an exact
    // rejection message, and the interval where the search endpoint has not yet
    // begun serving a freshly ACTIVE index answers its own ValidationException
    // — for the 'plain' index, one whose wording ("does not have the specified
    // index") is indistinguishable from the answer for a name that never
    // existed. Waiting on the description alone would let that stand in for
    // whichever message the case actually asked for.
    await waitForVectorIndexSearchable({
      tableName,
      indexName: 'plain',
      searchVector: vec(1, 0, 0),
    })
    await waitForVectorIndexSearchable({
      tableName,
      indexName: 'schema',
      searchVector: vec(1, 0, 0),
      searchConditionExpression: 'tenant = :t',
      expressionAttributeValues: { ':t': { S: 'probe' } },
    })
  })

  afterAll(async () => {
    if (created) await deleteTable(tableName)
  })

  it('TopK above the maximum', async () => {
    await expectExactRejection(
      { TableName: tableName, IndexName: 'plain', SearchVector: vec(1, 0, 0), TopK: 101 },
      "Provided TopK value '101' is out of valid range. The value must be between 1 and 100 inclusive",
    )
  })

  it('missing SearchConditionExpression against a HASH-schema index', async () => {
    await expectExactRejection(
      { TableName: tableName, IndexName: 'schema', SearchVector: vec(1, 0, 0), TopK: 1 },
      'SearchConditionExpression must be provided when SearchSchema has a HASH key',
    )
  })

  it('non-equality comparator on the HASH element', async () => {
    await expectExactRejection(
      {
        TableName: tableName,
        IndexName: 'schema',
        SearchVector: vec(1, 0, 0),
        TopK: 1,
        SearchConditionExpression: 'tenant < :t',
        ExpressionAttributeValues: { ':t': { S: 't9' } },
      },
      'Invalid SearchConditionExpression: Invalid comparator used in SearchConditionExpression',
    )
  })

  it('non-equality comparator on an INLINE_FILTER element', async () => {
    await expectExactRejection(
      {
        TableName: tableName,
        IndexName: 'schema',
        SearchVector: vec(1, 0, 0),
        TopK: 1,
        SearchConditionExpression: 'tenant = :t AND category < :c',
        ExpressionAttributeValues: { ':t': { S: 't1' }, ':c': { S: 'c9' } },
      },
      'Invalid SearchConditionExpression: Invalid comparator used in SearchConditionExpression',
    )
  })

  it('query vector dimension mismatch', async () => {
    await expectExactRejection(
      { TableName: tableName, IndexName: 'plain', SearchVector: vec(1, 0), TopK: 1 },
      'Input search vector dimension 2 does not match vector index dimension 3',
    )
  })

  it('condition attribute outside the SearchSchema', async () => {
    await expectExactRejection(
      {
        TableName: tableName,
        IndexName: 'plain',
        SearchVector: vec(1, 0, 0),
        TopK: 1,
        SearchConditionExpression: 'tenant = :t',
        ExpressionAttributeValues: { ':t': { S: 't1' } },
      },
      'SearchConditionExpression must not contain any attributes that is not in SearchSchema. Invalid attribute: tenant',
    )
  })

  it('L-wrapped search vector', async () => {
    await expectExactRejection(
      {
        TableName: tableName,
        IndexName: 'plain',
        SearchVector: [{ L: vec(1, 0, 0) }],
        TopK: 1,
      },
      'Search vector contains invalid values. All values in the search vector must be a 32-bit floating-point number attribute',
    )
  })
})

describe('SearchVectors - request shape errors', { tags: ['search-vectors', 'data-plane', 'vector', 'negative-path'] }, () => {
  skipUnlessVectorSearch()

  // SearchVectors reads its body with a strict deserialiser before it
  // validates any member. An explicit null for a member is a
  // SerializationException quoting the deserialiser, and a missing TableName
  // is a ValidationException naming the field; the missing field comes
  // before a too-short IndexName. Both regions (eu-west-2, us-east-1,
  // 2026-10-09). The column depends on the body's layout, so it is matched
  // as a number. The table is never looked up.
  const absent = absentTableName('vec_shape_absent')
  const valid = { TableName: absent, IndexName: 'vix', SearchVector: [{ N: '1' }], TopK: 1 }

  async function answer(command: SearchVectorsCommand): Promise<{ name: string; message: string }> {
    try {
      await ddb.send(command)
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      return { name: err.name, message: err.message }
    }
    expect.unreachable('should have thrown')
    return { name: '', message: '' }
  }

  // The SDK drops null members, so the body is replaced before signing.
  function withBody(body: Record<string, unknown>): SearchVectorsCommand {
    const command = new SearchVectorsCommand(valid as SearchVectorsCommandInput)
    const json = JSON.stringify(body)
    command.middlewareStack.add(
      (next) => async (args: any) => {
        args.request.body = json
        args.request.headers['content-length'] = String(Buffer.byteLength(json))
        return next(args)
      },
      { step: 'build', priority: 'high', name: 'searchVectorsRawBody' },
    )
    return command
  }

  it('refuses an explicit null member as a SerializationException', async () => {
    const got = [
      await answer(withBody({ ...valid, IndexName: null })),
      await answer(withBody({ ...valid, TableName: null })),
      await answer(withBody({ ...valid, SearchVector: null })),
      await answer(withBody({ ...valid, TopK: null })),
    ]
    expect(got.map((g) => g.name)).toEqual(Array(4).fill('SerializationException'))
    expect(got[0].message).toMatch(/^invalid type: null, expected a string at line 1 column \d+$/)
    expect(got[1].message).toMatch(/^invalid type: null, expected a string at line 1 column \d+$/)
    expect(got[2].message).toMatch(/^invalid type: null, expected a sequence at line 1 column \d+$/)
    expect(got[3].message).toMatch(/^invalid type: null, expected i32 at line 1 column \d+$/)
  })

  it('names a missing TableName as a missing field, before a too-short IndexName', async () => {
    const { TableName: _omit, ...withoutName } = valid
    const missing = await answer(new SearchVectorsCommand(withoutName as SearchVectorsCommandInput))
    const missingAndShort = await answer(new SearchVectorsCommand({ ...withoutName, IndexName: 'ab' } as SearchVectorsCommandInput))
    for (const got of [missing, missingAndShort]) {
      expect(got.name).toBe('ValidationException')
      expect(got.message).toMatch(/^missing field `TableName` at line 1 column \d+$/)
    }
  })
})
