import {
  QueryCommand,
  ScanCommand,
  ExecuteStatementCommand,
  DynamoDBServiceException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { isUnsupportedFault } from '../../../src/infra.js'
import { compositeIndexedTableDef, declareTables } from '../../../src/helpers.js'

// The index-bearing error-message cases, kept out of query.test.ts and
// scan.test.ts so those files declare no indexed table. Each request names a
// real index, so the rejection is the message under test rather than an
// index-not-found error.
declareTables(compositeIndexedTableDef)

describe('Query — index error messages', { tags: ['query', 'data-plane', 'negative-path', 'gsi', 'lsi'] }, () => {
  it('ConsistentRead on GSI', async () => {
    try {
      await ddb.send(
        new QueryCommand({
          TableName: compositeIndexedTableDef.name,
          IndexName: 'gsi1',
          KeyConditionExpression: '#hk = :v',
          ExpressionAttributeNames: { '#hk': 'lsi1sk' },
          ExpressionAttributeValues: { ':v': { S: 'val' } },
          ConsistentRead: true,
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Consistent reads are not supported on global secondary indexes',
      )
    }
  })
})

describe('Scan — index error messages', { tags: ['scan', 'data-plane', 'negative-path', 'gsi', 'lsi'] }, () => {
  // Parity with Query: a Scan on a GSI cannot ask for a strongly consistent read.
  it('ConsistentRead on a GSI: full consistent-reads-unsupported message', async () => {
    try {
      await ddb.send(
        new ScanCommand({
          TableName: compositeIndexedTableDef.name,
          IndexName: 'gsi1',
          ConsistentRead: true,
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Consistent reads are not supported on global secondary indexes',
      )
    }
  })
})

describe('ExecuteStatement — index error messages', { tags: ['partiql', 'data-plane', 'negative-path', 'gsi'] }, () => {
  let supported = true

  beforeAll(async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT * FROM "${compositeIndexedTableDef.name}" WHERE pk = 'partiql-canary'`,
      }))
    } catch (e: unknown) {
      if (isUnsupportedFault(e) || (e instanceof Error && e.name === 'UnrecognizedClientException')) {
        supported = false
      }
    }
  })

  beforeEach(({ skip }) => { if (!supported) skip() })

  // Parity with Query/Scan, but ExecuteStatement uses its own wording.
  // Characterised on real AWS (eu-west-1, 2026-09-02).
  it('ConsistentRead on a GSI-qualified statement: distinct ExecuteStatement wording', async () => {
    try {
      await ddb.send(
        new ExecuteStatementCommand({
          Statement: `SELECT * FROM "${compositeIndexedTableDef.name}"."gsi1"`,
          ConsistentRead: true,
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Strongly consistent read is not supported on Global Secondary Indexes',
      )
    }
  })

  it('unknown index omits the index name from the message', async () => {
    try {
      await ddb.send(
        new ExecuteStatementCommand({
          Statement: `SELECT * FROM "${compositeIndexedTableDef.name}"."no-such-index"`,
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'The table does not have the specified index',
      )
    }
  })

  it('unknown index wins over the ConsistentRead rejection', async () => {
    // Characterised on real AWS (eu-west-1, 2026-09-02): index resolution is
    // validated before the consistent-read check.
    try {
      await ddb.send(
        new ExecuteStatementCommand({
          Statement: `SELECT * FROM "${compositeIndexedTableDef.name}"."no-such-index"`,
          ConsistentRead: true,
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'The table does not have the specified index',
      )
    }
  })
})
