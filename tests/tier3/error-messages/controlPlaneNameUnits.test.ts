import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBServiceException,
  ListTablesCommand,
  UpdateTableCommand,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { absentTableName, deleteTable } from '../../../src/helpers.js'

// How the table and index operations measure a name. Captured in eu-west-2
// and us-east-1, 2026-11-05; the CreateTable, DescribeTable, UpdateTable,
// ListTables and CreateTable GSI cases also in 33 regions.
//
// A table name is counted in UTF-16 code units, so two emoji (four units) are
// long enough and 128 emoji (256 units) are too long. ListTables'
// ExclusiveStartTableName and an index name are counted in characters, so the
// same two emoji are too short and 128 are not too long. Where both of those
// errors are listed, regions disagree on their order, so they are compared as
// a set.

const TWO_EMOJI = '😀😀'
const MANY_EMOJI = '😀'.repeat(128)
const ATTR = [{ AttributeName: 'pk', AttributeType: 'S' as const }]
const KEY_SCHEMA = [{ AttributeName: 'pk', KeyType: 'HASH' as const }]

const nameError = (value: string, at: string, rule: string) =>
  `Value '${value}' at '${at}' failed to satisfy constraint: Member must ${rule}`
const TOO_SHORT = 'have length greater than or equal to 3'
const TOO_LONG = 'have length less than or equal to 255'
const PATTERN = 'satisfy regular expression pattern: [a-zA-Z0-9_.-]+'
const detected = (...errors: string[]) =>
  `${errors.length} validation error${errors.length === 1 ? '' : 's'} detected: ${errors.join('; ')}`

// The envelope and each error exactly, in whatever order the region lists them.
function expectErrorSet(message: string, errors: string[]) {
  const envelope = `${errors.length} validation errors detected: `
  expect(message.startsWith(envelope)).toBe(true)
  expect(message.slice(envelope.length).split('; ').sort()).toEqual([...errors].sort())
}

describe('Table and index operations measure a name', { tags: ['create-table', 'describe-table', 'delete-table', 'update-table', 'list-tables', 'control-plane', 'negative-path'] }, () => {
  // An index-name case names a table that is valid, so a create that is
  // wrongly accepted is cleaned up here.
  const created: string[] = []

  afterAll(async () => {
    await Promise.all(created.map(deleteTable))
  })

  async function refusal(send: () => Promise<unknown>, tableName?: string): Promise<string> {
    try {
      await send()
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      return err.message
    }
    if (tableName) created.push(tableName)
    expect.unreachable('should have thrown')
    return ''
  }

  const create = (TableName: string) => () =>
    ddb.send(new CreateTableCommand({ TableName, BillingMode: 'PAY_PER_REQUEST', AttributeDefinitions: ATTR, KeySchema: KEY_SCHEMA }))
  const describeTable = (TableName: string) => () => ddb.send(new DescribeTableCommand({ TableName }))
  const deleteNamed = (TableName: string) => () => ddb.send(new DeleteTableCommand({ TableName }))
  const update = (TableName: string) => () => ddb.send(new UpdateTableCommand({ TableName, BillingMode: 'PAY_PER_REQUEST' }))

  describe('table names, in UTF-16 units', () => {
    it('CreateTable does not find two emoji too short', async () => {
      expect(await refusal(create(TWO_EMOJI))).toBe(detected(nameError(TWO_EMOJI, 'tableName', PATTERN)))
    })

    it('CreateTable finds 128 emoji too long', async () => {
      expect(await refusal(create(MANY_EMOJI))).toBe(
        detected(nameError(MANY_EMOJI, 'tableName', TOO_LONG), nameError(MANY_EMOJI, 'tableName', PATTERN)),
      )
    })

    it('DescribeTable does not find two emoji too short', async () => {
      expect(await refusal(describeTable(TWO_EMOJI))).toBe(detected(nameError(TWO_EMOJI, 'tableName', PATTERN)))
    })

    it('DescribeTable finds 128 emoji too long', async () => {
      expect(await refusal(describeTable(MANY_EMOJI))).toBe(
        detected(nameError(MANY_EMOJI, 'tableName', TOO_LONG), nameError(MANY_EMOJI, 'tableName', PATTERN)),
      )
    })

    it('DeleteTable does not find two emoji too short', async () => {
      expect(await refusal(deleteNamed(TWO_EMOJI))).toBe(detected(nameError(TWO_EMOJI, 'tableName', PATTERN)))
    })

    it('DeleteTable finds 128 emoji too long', async () => {
      expect(await refusal(deleteNamed(MANY_EMOJI))).toBe(
        detected(nameError(MANY_EMOJI, 'tableName', TOO_LONG), nameError(MANY_EMOJI, 'tableName', PATTERN)),
      )
    })

    it('UpdateTable does not find two emoji too short', async () => {
      expect(await refusal(update(TWO_EMOJI))).toBe(detected(nameError(TWO_EMOJI, 'tableName', PATTERN)))
    })

    it('UpdateTable finds 128 emoji too long', async () => {
      expect(await refusal(update(MANY_EMOJI))).toBe(
        detected(nameError(MANY_EMOJI, 'tableName', TOO_LONG), nameError(MANY_EMOJI, 'tableName', PATTERN)),
      )
    })
  })

  describe('ListTables and index names, in characters', () => {
    const AT_START = 'exclusiveStartTableName'
    const AT_GSI = 'globalSecondaryIndexes.1.member.indexName'
    const AT_LSI = 'localSecondaryIndexes.1.member.indexName'
    const AT_GSI_CREATE = 'globalSecondaryIndexUpdates.1.member.create.indexName'

    const listFrom = (ExclusiveStartTableName: string) => () => ddb.send(new ListTablesCommand({ ExclusiveStartTableName, Limit: 1 }))
    // A base table for each kind of index. The index itself is added in the
    // test, which carries that index's tag.
    const GSI_BASE = {
      BillingMode: 'PAY_PER_REQUEST' as const,
      AttributeDefinitions: [...ATTR, { AttributeName: 'g', AttributeType: 'S' as const }],
      KeySchema: KEY_SCHEMA,
    }
    const gsi = (IndexName: string) => ({
      IndexName,
      KeySchema: [{ AttributeName: 'g', KeyType: 'HASH' as const }],
      Projection: { ProjectionType: 'KEYS_ONLY' as const },
    })
    const LSI_BASE = {
      BillingMode: 'PAY_PER_REQUEST' as const,
      AttributeDefinitions: [...ATTR, { AttributeName: 's', AttributeType: 'S' as const }, { AttributeName: 'l', AttributeType: 'S' as const }],
      KeySchema: [...KEY_SCHEMA, { AttributeName: 's', KeyType: 'RANGE' as const }],
    }
    const lsi = (IndexName: string) => ({
      IndexName,
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' as const }, { AttributeName: 'l', KeyType: 'RANGE' as const }],
      Projection: { ProjectionType: 'KEYS_ONLY' as const },
    })
    const addGsi = (IndexName: string) => () =>
      ddb.send(
        new UpdateTableCommand({
          TableName: absentTableName('name_units_absent'),
          AttributeDefinitions: [...ATTR, { AttributeName: 'g', AttributeType: 'S' }],
          GlobalSecondaryIndexUpdates: [
            { Create: { IndexName, KeySchema: [{ AttributeName: 'g', KeyType: 'HASH' }], Projection: { ProjectionType: 'KEYS_ONLY' } } },
          ],
        }),
      )

    it('ListTables finds two emoji too short', async () => {
      expectErrorSet(await refusal(listFrom(TWO_EMOJI)), [nameError(TWO_EMOJI, AT_START, TOO_SHORT), nameError(TWO_EMOJI, AT_START, PATTERN)])
    })

    it('ListTables does not find 128 emoji too long', async () => {
      expect(await refusal(listFrom(MANY_EMOJI))).toBe(detected(nameError(MANY_EMOJI, AT_START, PATTERN)))
    })

    it('CreateTable finds a GSI name of two emoji too short', { tags: ['gsi'] }, async () => {
      const table = absentTableName('name_units_gsi_short')
      const send = () => ddb.send(new CreateTableCommand({ TableName: table, ...GSI_BASE, GlobalSecondaryIndexes: [gsi(TWO_EMOJI)] }))
      expectErrorSet(await refusal(send, table), [
        nameError(TWO_EMOJI, AT_GSI, TOO_SHORT),
        nameError(TWO_EMOJI, AT_GSI, PATTERN),
      ])
    })

    it('CreateTable does not find a GSI name of 128 emoji too long', { tags: ['gsi'] }, async () => {
      const table = absentTableName('name_units_gsi_long')
      const send = () => ddb.send(new CreateTableCommand({ TableName: table, ...GSI_BASE, GlobalSecondaryIndexes: [gsi(MANY_EMOJI)] }))
      expect(await refusal(send, table)).toBe(detected(nameError(MANY_EMOJI, AT_GSI, PATTERN)))
    })

    it('CreateTable finds an LSI name of two emoji too short', { tags: ['lsi'] }, async () => {
      const table = absentTableName('name_units_lsi_short')
      const send = () => ddb.send(new CreateTableCommand({ TableName: table, ...LSI_BASE, LocalSecondaryIndexes: [lsi(TWO_EMOJI)] }))
      expectErrorSet(await refusal(send, table), [
        nameError(TWO_EMOJI, AT_LSI, TOO_SHORT),
        nameError(TWO_EMOJI, AT_LSI, PATTERN),
      ])
    })

    it('CreateTable does not find an LSI name of 128 emoji too long', { tags: ['lsi'] }, async () => {
      const table = absentTableName('name_units_lsi_long')
      const send = () => ddb.send(new CreateTableCommand({ TableName: table, ...LSI_BASE, LocalSecondaryIndexes: [lsi(MANY_EMOJI)] }))
      expect(await refusal(send, table)).toBe(detected(nameError(MANY_EMOJI, AT_LSI, PATTERN)))
    })

    it('UpdateTable finds a new GSI name of two emoji too short', { tags: ['gsi'] }, async () => {
      expectErrorSet(await refusal(addGsi(TWO_EMOJI)), [
        nameError(TWO_EMOJI, AT_GSI_CREATE, TOO_SHORT),
        nameError(TWO_EMOJI, AT_GSI_CREATE, PATTERN),
      ])
    })

    it('UpdateTable does not find a new GSI name of 128 emoji too long', { tags: ['gsi'] }, async () => {
      expect(await refusal(addGsi(MANY_EMOJI))).toBe(detected(nameError(MANY_EMOJI, AT_GSI_CREATE, PATTERN)))
    })
  })
})
