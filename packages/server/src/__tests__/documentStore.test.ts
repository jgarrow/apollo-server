import gql from 'graphql-tag';
import { ApolloServerBase } from '../ApolloServer';
import type { BaseContext } from '@apollo/server-types';
import { KeyvLRU } from '../utils/KeyvLRU';
import Keyv from 'keyv';
import type { DocumentNode } from 'graphql';

const typeDefs = gql`
  type Query {
    hello: String
  }
`;

const resolvers = {
  Query: {
    hello() {
      return 'world';
    },
  },
};

const documentNodeMatcher = {
  kind: 'Document',
  definitions: expect.any(Array),
  loc: {
    start: 0,
    end: 15,
  },
};

const hash = 'ec2e01311ab3b02f3d8c8c712f9e579356d332cd007ac4c1ea5df727f482f05f';
const operations = {
  simple: {
    op: { query: 'query { hello }' },
    hash,
  },
};

describe('ApolloServerBase documentStore', () => {
  it('documentStore - undefined', async () => {
    const server = new ApolloServerBase<BaseContext>({
      typeDefs,
      resolvers,
    });

    await server.start();

    const options = await server['graphQLServerOptions']();
    const embeddedStore = options.documentStore!;
    expect(embeddedStore).toBeInstanceOf(Keyv);

    await server.executeOperation(operations.simple.op);

    expect(embeddedStore.getTotalSize()).toBe(508);

    expect(await embeddedStore.get(operations.simple.hash)).toMatchObject(
      documentNodeMatcher,
    );
  });

  it('documentStore - custom', async () => {
    const documentStore = new KeyvLRU<DocumentNode>();

    const getSpy = jest.spyOn(documentStore, 'get');
    const setSpy = jest.spyOn(documentStore, 'set');

    const server = new ApolloServerBase({
      typeDefs,
      resolvers,
      documentStore,
    });
    await server.start();

    await server.executeOperation(operations.simple.op);

    let cache: Record<string, DocumentNode | undefined> = {};

    cache[hash] = await documentStore.get(hash);

    expect(Object.keys(cache)).toEqual([hash]);
    expect(cache[hash]).toMatchObject(documentNodeMatcher);

    await server.executeOperation(operations.simple.op);

    expect(Object.keys(cache)).toEqual([hash]);

    // one of these calls is ours
    expect(getSpy.mock.calls.length).toBe(2 + 1);
    expect(setSpy.mock.calls.length).toBe(1);
  });

  it('documentStore - null', async () => {
    const server = new ApolloServerBase<BaseContext>({
      typeDefs,
      resolvers,
      documentStore: null,
    });

    await server.start();

    const options = await server['graphQLServerOptions']();
    expect(options.documentStore).toBe(null);

    const result = await server.executeOperation(operations.simple.op);

    expect(result.data).toEqual({ hello: 'world' });
  });
});
