import gql from 'graphql-tag';
import { ApolloServerBase } from '../ApolloServer';
import type { BaseContext } from '@apollo/server-types';
import { getKeyvDocumentNodeLRU, LRU } from '../utils/KeyvDocumentNodeLRU';
import Keyv from 'keyv';
import type { DocumentStore } from '..';

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
    const embeddedStore = options.documentStore as DocumentStore;
    expect(embeddedStore).toBeInstanceOf(Keyv);

    await server.executeOperation(operations.simple.op);

    // @ts-ignore Keyv.opts isn't defined in the typings
    expect(await embeddedStore.opts.getTotalSize()).toBe(508);

    expect(await embeddedStore.get(operations.simple.hash)).toMatchObject(
      documentNodeMatcher,
    );
  });

  it('documentStore - custom', async () => {
    const documentStore = getKeyvDocumentNodeLRU();

    const getSpy = jest.spyOn(documentStore, 'get');
    const setSpy = jest.spyOn(documentStore, 'set');

    const server = new ApolloServerBase({
      typeDefs,
      resolvers,
      documentStore,
    });
    await server.start();

    await server.executeOperation(operations.simple.op);

    let cache: Record<string, string | undefined> = {};

    // @ts-ignore
    const store = documentStore.opts.store as LRU<string, string>;

    const keys = store.keys();
    for (const key of keys) {
      cache[key] = store.get(key);
    }

    const cacheKey = `apollo:${hash}`;
    expect(Object.keys(cache)).toEqual([cacheKey]);
    expect(JSON.parse(cache[cacheKey]!).value).toMatchObject(documentNodeMatcher);

    await server.executeOperation(operations.simple.op);

    expect(Object.keys(cache)).toEqual([cacheKey]);

    expect(getSpy.mock.calls.length).toBe(2);
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
