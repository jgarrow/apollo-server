// Create ~about~ a 30MiB LRU. This is less than precise
    // since the technique to calculate the size of a DocumentNode is
    // only using JSON.stringify on the DocumentNode (and thus doesn't account
    // for unicode characters, etc.), but it should do a reasonable job at
    // providing a caching document store for most operations.
    //

import LRUCache from "lru-cache";
import Keyv, { Store, type Options } from 'keyv';
import type { DocumentNode } from "graphql";

// LRUCache wrapper to implement the Keyv `Store` interface.
export class LRU<V> extends LRUCache<string, V> implements Store<V> {
  async delete(key: string): Promise<boolean> {
    try {
      super.del(key);
      return true;
    } catch {
      return false
    }
  }
  async clear() {
    return super.reset();
  }

  static jsonBytesSizeCalculator(obj: DocumentNode) {
    return Buffer.byteLength(JSON.stringify(obj), 'utf8')
  }
}

export interface KeyvDocumentNodeLRUOptions extends Options<DocumentNode> {
  store?: LRU<DocumentNode>;
}

export function getKeyvDocumentNodeLRU(opts?: KeyvDocumentNodeLRUOptions) {
  return new Keyv<DocumentNode>({
    namespace: 'apollo',
    store: new LRU<DocumentNode>({
      max: Math.pow(2, 20) * 30,
      length(obj) {
        return LRU.jsonBytesSizeCalculator(obj);
      },
    }),
    async getTotalSize() {
      return (this.store! as LRU<DocumentNode>).length;
    },
    ...opts,
  });
}
