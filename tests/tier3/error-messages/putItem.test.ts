import {
  PutItemCommand,
  DynamoDBServiceException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import {
  hashTableDef,
  hashBTableDef,
  cleanupItems,
  declareTables,
} from '../../../src/helpers.js'

declareTables(hashTableDef, hashBTableDef)

const keysToCleanup = [
  { pk: { S: 'em-put-null-false' } },
]

afterAll(async () => {
  await cleanupItems(hashTableDef.name, keysToCleanup)
})

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('PutItem — exact error messages', { tags: ['put-item', 'data-plane'] }, () => {
  it('missing table name: full validation error string', async () => {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: undefined as unknown as string,
          Item: { pk: { S: 'test' } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        "1 validation error detected: Value null at 'tableName' failed to satisfy constraint: Member must not be null",
      )
    }
  })

  it('empty table name: minimum length 1 error', async () => {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: '',
          Item: { pk: { S: 'test' } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      // Structural assertion: pin the contractual field and constraint, float
      // the envelope prefix, echoed value and field casing that AWS varies by
      // region (2026-06 four-region capture; same idea as createTable's
      // backend-variant handling). See CONTRIBUTING, "error-messages".
      expect((err as DynamoDBServiceException).message.toLowerCase()).toContain(
        "tablename",
      )
      expect((err as DynamoDBServiceException).message).toContain(
        'failed to satisfy constraint: Member must have length greater than or equal to 1',
      )
    }
  })

  it('table name too long (256 chars): maximum length 255 error', async () => {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: 'a'.repeat(256),
          Item: { pk: { S: 'test' } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        `1 validation error detected: Value '${'a'.repeat(256)}' at 'tableName' failed to satisfy constraint: Member must have length less than or equal to 255`,
      )
    }
  })

  it('table name with invalid chars: regex pattern error', async () => {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: 'bad table!@#',
          Item: { pk: { S: 'test' } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        "1 validation error detected: Value 'bad table!@#' at 'tableName' failed to satisfy constraint: Member must satisfy regular expression pattern: [a-zA-Z0-9_.-]+",
      )
    }
  })

  it('empty string set: full parameter-values-invalid error', async () => {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'test' }, bad: { SS: [] } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toContain(
        'One or more parameter values were invalid: An string set  may not be empty',
      )
    }
  })

  it('empty number set: full parameter-values-invalid error', async () => {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'test' }, bad: { NS: [] } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toContain(
        'One or more parameter values were invalid: An number set  may not be empty',
      )
    }
  })

  it('duplicate values in SS: full duplicates error', async () => {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'test' }, bad: { SS: ['a', 'a'] } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      // Float the collection rendering (["a", "a"] in newer regions, [a, a] in
      // older ones); pin the bespoke message either side of it.
      expect((err as DynamoDBServiceException).message).toContain(
        'One or more parameter values were invalid: Input collection',
      )
      expect((err as DynamoDBServiceException).message).toContain('contains duplicates')
    }
  })

  it('empty binary set: full parameter-values-invalid error', async () => {
    // Binary uses entirely different wording from the string/number set
    // messages (no two-space quirk, different verb).
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'test' }, bad: { BS: [] } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toContain(
        'One or more parameter values were invalid: Binary sets should not be empty',
      )
    }
  })

  it('empty string member in NS: numeric conversion error', async () => {
    // A set may hold an empty string member (SS) or zero-length binary member
    // (BS); NS rejects '' because it is not a number, not because it is empty.
    // Structural assertion: the core is invariant across the 2026-07 four-region
    // capture; newer-wording regions add the envelope prefix and echo the
    // (empty) offending value after a trailing colon, both floated here.
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'test' }, bad: { NS: [''] } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toContain(
        'The parameter cannot be converted to a numeric value',
      )
    }
  })

  it('duplicate empty string members in SS: full duplicates error', async () => {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'test' }, bad: { SS: ['', ''] } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      // Float the collection rendering and any envelope prefix; pin the bespoke
      // message either side of it, as the non-empty duplicate case above does.
      expect((err as DynamoDBServiceException).message).toContain(
        'One or more parameter values were invalid: Input collection',
      )
      expect((err as DynamoDBServiceException).message).toContain('contains duplicates')
    }
  })

  it('duplicate zero-length members in BS: full duplicates error', async () => {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: {
            pk: { S: 'test' },
            bad: { BS: [new Uint8Array(0), new Uint8Array(0)] },
          },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toContain(
        'One or more parameter values were invalid: Input collection',
      )
      // The binary form names the set type, with AWS's missing space before
      // 'of' ("...]of type BS...") - invariant across the 2026-07 four-region
      // capture, only the collection rendering and envelope vary.
      expect((err as DynamoDBServiceException).message).toContain(
        'of type BS contains duplicates',
      )
    }
  })

  it('rejects a { NULL: false } attribute value with a ValidationException', async () => {
    // A NULL attribute value must carry true; { NULL: false } is rejected.
    // eu-west-2 and eu-central-1 briefly accepted it and normalised to
    // { NULL: true } on read - a per-region split the suite tracked - but by
    // the 2026-07-17 ground-truth sweep both had reverted and every region
    // rejects again, so the split was retired and this asserts the shared
    // rejection. The envelope prefix ("1 validation error detected: ") still
    // varies by region and is mid-rollout - six regions prefixed, twenty-seven
    // bare in captures/2026-07-21-null-false-envelope.json - so match the
    // invariant clause, not the exact string.
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'em-put-null-false' }, attr1: { NULL: false } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toContain(
        'One or more parameter values were invalid: Null attribute value types must have the value of true',
      )
    }
  })

  it('mixing expression and non-expression: full conflict error', { tags: ['legacy'] }, async () => {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'test' } },
          Expected: { pk: { Exists: false } },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toContain(
        'Can not use both expression and non-expression parameters in the same request: Non-expression parameters: {Expected} Expression parameters: {ConditionExpression}',
      )
    }
  })

  it('ExpressionAttributeValues without expression: full unused-EAV error', async () => {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'test' } },
          ExpressionAttributeValues: { ':v': { S: 'unused' } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toContain(
        'ExpressionAttributeValues can only be specified when using expressions',
      )
    }
  })

  it('redundant parentheses in ConditionExpression: full error string', async () => {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'em-put-redundant' } },
          ConditionExpression: '((attribute_not_exists(pk)))',
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toContain(
        'Invalid ConditionExpression: The expression has redundant parentheses;',
      )
    }
  })

  it('contains() with duplicate path and operand: full distinct-operand error', async () => {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'em-put-contains-dup' } },
          ConditionExpression: 'contains(#a, #a)',
          ExpressionAttributeNames: { '#a': 'data' },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toContain(
        'Invalid ConditionExpression: The first operand must be distinct from the remaining operands for this operator or function; operator: contains, first operand: [data]',
      )
    }
  })

  it('empty-binary item key value: full ValidationException message', async () => {
    // Real AWS rejects a zero-length binary key value with a top-level
    // ValidationException, the binary analogue of the empty-string key rejection.
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: hashBTableDef.name,
          Item: { pk: { B: new Uint8Array([]) } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'One or more parameter values are not valid. The AttributeValue for a key attribute cannot contain an empty binary value. Key: pk',
      )
    }
  })
})

describe('PutItem - request validation envelope', { tags: ['put-item', 'data-plane', 'negative-path'] }, () => {
  // Each of these is reported inside the `1 validation error detected: `
  // envelope, and the ExpressionAttributeValues message carries no
  // ": ConditionExpression is null" suffix. Both regions (eu-west-2,
  // us-east-1, 2026-10-09).
  const Item = { pk: { S: 'em-put-envelope' } }
  const one = (m: string) => `1 validation error detected: ${m}`

  async function message(input: Record<string, unknown>): Promise<string> {
    try {
      await ddb.send(new PutItemCommand({ TableName: hashTableDef.name, Item, ...input } as any))
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      return err.message
    }
    expect.unreachable('should have thrown')
    return ''
  }

  it('ExpressionAttributeValues or ExpressionAttributeNames without an expression', async () => {
    expect(await message({ ExpressionAttributeValues: { ':v': { S: 'x' } } })).toBe(
      one('ExpressionAttributeValues can only be specified when using expressions'),
    )
    expect(await message({ ExpressionAttributeNames: { '#a': 'a' } })).toBe(
      one('ExpressionAttributeNames can only be specified when using expressions'),
    )
  })

  it('an empty ConditionExpression', async () => {
    expect(await message({ ConditionExpression: '' })).toBe(one('Invalid ConditionExpression: The expression can not be empty;'))
  })

  it('a malformed Expected condition', { tags: ['legacy'] }, async () => {
    expect(await message({ Expected: { a: { Exists: true } } })).toBe(
      one('One or more parameter values were invalid: Value must be provided when Exists is true for Attribute: a'),
    )
    expect(await message({ Expected: { a: { ComparisonOperator: 'EQ' } } })).toBe(
      one('One or more parameter values were invalid: Value or AttributeValueList must be used with ComparisonOperator: EQ for Attribute: a'),
    )
  })
})
