/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 * @emails oncall+relay
 * @format
 */

'use strict';

const ExecutionEnvironment = require('fbjs/lib/ExecutionEnvironment');
const LRUCache = require('./LRUCache');

const invariant = require('invariant');

const {isPromise, RelayFeatureFlags} = require('relay-runtime');

const CACHE_CAPACITY = 1000;

const DEFAULT_FETCH_POLICY = 'store-or-network';
const DEFAULT_RENDER_POLICY =
  RelayFeatureFlags.ENABLE_PARTIAL_RENDERING_DEFAULT === true
    ? 'partial'
    : 'full';

const DATA_RETENTION_TIMEOUT = 30 * 1000;

import type {
  Disposable,
  FragmentPointer,
  GraphQLResponse,
  IEnvironment,
  Observable,
  Observer,
  OperationDescriptor,
  ReaderFragment,
  Snapshot,
} from 'relay-runtime';
import type {Cache} from './LRUCache';

export type QueryResource = QueryResourceImpl;
export type FetchPolicy =
  | 'store-only'
  | 'store-or-network'
  | 'store-and-network'
  | 'network-only';
export type RenderPolicy = 'full' | 'partial';

type QueryResourceCache = Cache<QueryResourceCacheEntry>;
type QueryResourceCacheEntry = {|
  +cacheKey: string,
  getRetainCount(): number,
  getValue(): Error | Promise<void> | QueryResult,
  setValue(Error | Promise<void> | QueryResult): void,
  temporaryRetain(environment: IEnvironment): void,
  permanentRetain(environment: IEnvironment): Disposable,
|};
opaque type QueryResult: {
  fragmentNode: ReaderFragment,
  fragmentRef: FragmentPointer,
} = {|
  cacheKey: string,
  fragmentNode: ReaderFragment,
  fragmentRef: FragmentPointer,
  operation: OperationDescriptor,
|};

function getQueryCacheKey(
  operation: OperationDescriptor,
  fetchPolicy: FetchPolicy,
  renderPolicy: RenderPolicy,
): string {
  return `${fetchPolicy}-${renderPolicy}-${operation.request.identifier}`;
}

function getQueryResult(
  operation: OperationDescriptor,
  cacheKey: string,
): QueryResult {
  const rootFragmentRef = {
    __id: operation.fragment.dataID,
    __fragments: {
      [operation.fragment.node.name]: operation.request.variables,
    },
    __fragmentOwner: operation.request,
  };
  return {
    cacheKey,
    fragmentNode: operation.request.node.fragment,
    fragmentRef: rootFragmentRef,
    operation,
  };
}

function createQueryResourceCacheEntry(
  cacheKey: string,
  operation: OperationDescriptor,
  value: Error | Promise<void> | QueryResult,
  onDispose: QueryResourceCacheEntry => void,
): QueryResourceCacheEntry {
  let currentValue: Error | Promise<void> | QueryResult = value;
  let retainCount = 0;
  let permanentlyRetained = false;
  let retainDisposable: ?Disposable = null;
  let releaseTemporaryRetain: ?() => void = null;

  const retain = (environment: IEnvironment) => {
    retainCount++;
    if (retainCount === 1) {
      retainDisposable = environment.retain(operation.root);
    }
    return {
      dispose: () => {
        retainCount = Math.max(0, retainCount - 1);
        if (retainCount === 0) {
          invariant(
            retainDisposable != null,
            'Relay: Expected disposable to release query to be defined.' +
              "If you're seeing this, this is likely a bug in Relay.",
          );
          retainDisposable.dispose();
          retainDisposable = null;
        }
        onDispose(cacheEntry);
      },
    };
  };

  const cacheEntry = {
    cacheKey,
    getValue() {
      return currentValue;
    },
    setValue(val) {
      currentValue = val;
    },
    getRetainCount() {
      return retainCount;
    },
    temporaryRetain(environment: IEnvironment) {
      // NOTE: If we're executing in a server environment, there's no need
      // to create temporary retains, since the component will never commit.
      if (!ExecutionEnvironment.canUseDOM) {
        return;
      }

      if (permanentlyRetained === true) {
        return;
      }

      // NOTE: temporaryRetain is called during the render phase. However,
      // given that we can't tell if this render will eventually commit or not,
      // we create a timer to autodispose of this retain in case the associated
      // component never commits.
      // If the component /does/ commit, permanentRetain will clear this timeout
      // and permanently retain the data.
      const disposable = retain(environment);
      let releaseQueryTimeout = null;
      const localReleaseTemporaryRetain = () => {
        clearTimeout(releaseQueryTimeout);
        releaseQueryTimeout = null;
        releaseTemporaryRetain = null;
        disposable.dispose();
      };
      releaseQueryTimeout = setTimeout(
        localReleaseTemporaryRetain,
        DATA_RETENTION_TIMEOUT,
      );

      // NOTE: Since temporaryRetain can be called multiple times, we release
      // the previous temporary retain after we re-establish a new one, since
      // we only ever need a single temporary retain until the permanent retain is
      // established.
      // temporaryRetain may be called multiple times by React during the render
      // phase, as well multiple times by sibling query components that are
      // rendering the same query/variables.
      if (releaseTemporaryRetain != null) {
        releaseTemporaryRetain();
      }
      releaseTemporaryRetain = localReleaseTemporaryRetain;
    },
    permanentRetain(environment: IEnvironment) {
      const disposable = retain(environment);
      if (releaseTemporaryRetain != null) {
        releaseTemporaryRetain();
        releaseTemporaryRetain = null;
      }

      permanentlyRetained = true;
      return {
        dispose: () => {
          disposable.dispose();
          permanentlyRetained = false;
        },
      };
    },
  };

  return cacheEntry;
}

class QueryResourceImpl {
  _environment: IEnvironment;
  _cache: QueryResourceCache;
  _logQueryResource: ?(
    operation: OperationDescriptor,
    fetchPolicy: FetchPolicy,
    renderPolicy: RenderPolicy,
    hasFullQuery: boolean,
    shouldFetch: boolean,
  ) => void;

  constructor(environment: IEnvironment) {
    this._environment = environment;
    this._cache = LRUCache.create(CACHE_CAPACITY);
    if (__DEV__) {
      this._logQueryResource = (
        operation: OperationDescriptor,
        fetchPolicy: FetchPolicy,
        renderPolicy: RenderPolicy,
        hasFullQuery: boolean,
        shouldFetch: boolean,
      ): void => {
        if (
          // Disable relay network logging while performing Server-Side
          // Rendering (SSR)
          !ExecutionEnvironment.canUseDOM
        ) {
          return;
        }
        const logger = environment.getLogger({
          // $FlowFixMe
          request: {
            ...operation.request.node.params,
            name: `${operation.request.node.params.name} (Store Cache)`,
          },
          variables: operation.request.variables,
          cacheConfig: {},
        });
        if (!logger) {
          return;
        }
        logger.log('Fetch Policy', fetchPolicy);
        logger.log('Render Policy', renderPolicy);
        logger.log('Query', hasFullQuery ? 'Fully cached' : 'Has missing data');
        logger.log('Network Request', shouldFetch ? 'Required' : 'Skipped');
        logger.log('Variables', operation.request.variables);
        logger.flushLogs();
      };
    }
  }

  /**
   * This function should be called during a Component's render function,
   * to either read an existing cached value for the query, or fetch the query
   * and suspend.
   */
  prepare(
    operation: OperationDescriptor,
    fetchObservable: Observable<GraphQLResponse>,
    maybeFetchPolicy: ?FetchPolicy,
    maybeRenderPolicy: ?RenderPolicy,
    observer?: Observer<Snapshot>,
    cacheKeyBuster: ?string | ?number,
  ): QueryResult {
    const environment = this._environment;
    const fetchPolicy = maybeFetchPolicy ?? DEFAULT_FETCH_POLICY;
    const renderPolicy = maybeRenderPolicy ?? DEFAULT_RENDER_POLICY;
    let cacheKey = getQueryCacheKey(operation, fetchPolicy, renderPolicy);
    if (cacheKeyBuster != null) {
      cacheKey += `-${cacheKeyBuster}`;
    }

    // 1. Check if there's a cached value for this operation, and reuse it if
    // it's available
    let cacheEntry = this._cache.get(cacheKey);
    if (cacheEntry == null) {
      // 2. If a cached value isn't available, try fetching the operation.
      // fetchAndSaveQuery will update the cache with either a Promise or
      // an Error to throw, or a FragmentResource to return.
      cacheEntry = this._fetchAndSaveQuery(
        cacheKey,
        operation,
        fetchObservable,
        fetchPolicy,
        renderPolicy,
        observer,
      );
    }

    // Retain here in render phase. When the Component reading the operation
    // is committed, we will transfer ownership of data retention to the
    // component.
    // In case the component never mounts or updates from this render,
    // this data retention hold will auto-release itself afer a timeout.
    cacheEntry.temporaryRetain(environment);

    const cachedValue = cacheEntry.getValue();
    if (isPromise(cachedValue) || cachedValue instanceof Error) {
      throw cachedValue;
    }
    return cachedValue;
  }

  /**
   * This function should be called during a Component's commit phase
   * (e.g. inside useEffect), in order to retain the operation in the Relay store
   * and transfer ownership of the operation to the component lifecycle.
   */
  retain(queryResult: QueryResult): Disposable {
    const environment = this._environment;
    const {cacheKey, operation} = queryResult;
    let cacheEntry = this._cache.get(cacheKey);
    if (cacheEntry == null) {
      cacheEntry = createQueryResourceCacheEntry(
        cacheKey,
        operation,
        queryResult,
        this._onDispose,
      );
      this._cache.set(cacheKey, cacheEntry);
    }
    const disposable = cacheEntry.permanentRetain(environment);

    return {
      dispose: () => {
        disposable.dispose();
        invariant(
          cacheEntry != null,
          'Relay: Expected to have cached a result when disposing query.' +
            "If you're seeing this, this is likely a bug in Relay.",
        );
        this._onDispose(cacheEntry);
      },
    };
  }

  getCacheEntry(
    operation: OperationDescriptor,
    fetchPolicy: FetchPolicy,
    maybeRenderPolicy?: RenderPolicy,
  ): ?QueryResourceCacheEntry {
    const renderPolicy = maybeRenderPolicy ?? DEFAULT_RENDER_POLICY;
    const cacheKey = getQueryCacheKey(operation, fetchPolicy, renderPolicy);
    return this._cache.get(cacheKey);
  }

  _onDispose = (cacheEntry: QueryResourceCacheEntry): void => {
    if (cacheEntry.getRetainCount() <= 0) {
      this._cache.delete(cacheEntry.cacheKey);
    }
  };

  _cacheResult(operation: OperationDescriptor, cacheKey: string): void {
    const queryResult = getQueryResult(operation, cacheKey);
    const cacheEntry = createQueryResourceCacheEntry(
      cacheKey,
      operation,
      queryResult,
      this._onDispose,
    );
    this._cache.set(cacheKey, cacheEntry);
  }

  _fetchAndSaveQuery(
    cacheKey: string,
    operation: OperationDescriptor,
    fetchObservable: Observable<GraphQLResponse>,
    fetchPolicy: FetchPolicy,
    renderPolicy: RenderPolicy,
    observer?: Observer<Snapshot>,
  ): QueryResourceCacheEntry {
    const environment = this._environment;

    // NOTE: Running `check` will write missing data to the store using any
    // missing data handlers specified on the environment;
    // We run it here first to make the handlers get a chance to populate
    // missing data.
    const hasFullQuery = environment.check(operation.root);
    const canPartialRender = hasFullQuery || renderPolicy === 'partial';

    let shouldFetch;
    let shouldAllowRender;
    let resolveNetworkPromise = () => {};
    switch (fetchPolicy) {
      case 'store-only': {
        shouldFetch = false;
        shouldAllowRender = true;
        break;
      }
      case 'store-or-network': {
        shouldFetch = !hasFullQuery;
        shouldAllowRender = canPartialRender;
        break;
      }
      case 'store-and-network': {
        shouldFetch = true;
        shouldAllowRender = canPartialRender;
        break;
      }
      case 'network-only':
      default: {
        shouldFetch = true;
        shouldAllowRender = false;
        break;
      }
    }

    // NOTE: If this value is false, we will cache a promise for this
    // query, which means we will suspend here at this query root.
    // If it's true, we will cache the query resource and allow rendering to
    // continue.
    if (shouldAllowRender) {
      this._cacheResult(operation, cacheKey);
    }

    if (__DEV__) {
      switch (fetchPolicy) {
        case 'store-only':
        case 'store-or-network':
        case 'store-and-network':
          this._logQueryResource &&
            this._logQueryResource(
              operation,
              fetchPolicy,
              renderPolicy,
              hasFullQuery,
              shouldFetch,
            );
          break;
        default:
          break;
      }
    }

    if (shouldFetch) {
      const queryResult = getQueryResult(operation, cacheKey);
      fetchObservable.subscribe({
        start: observer?.start,
        next: () => {
          const snapshot = environment.lookup(operation.fragment);
          if (!snapshot.isMissingData) {
            const cacheEntry =
              this._cache.get(cacheKey) ??
              createQueryResourceCacheEntry(
                cacheKey,
                operation,
                queryResult,
                this._onDispose,
              );
            cacheEntry.setValue(queryResult);
            this._cache.set(cacheKey, cacheEntry);
            resolveNetworkPromise();
          }

          const observerNext = observer?.next;
          observerNext && observerNext(snapshot);
        },
        error: error => {
          const cacheEntry =
            this._cache.get(cacheKey) ??
            createQueryResourceCacheEntry(
              cacheKey,
              operation,
              error,
              this._onDispose,
            );
          cacheEntry.setValue(error);
          this._cache.set(cacheKey, cacheEntry);
          resolveNetworkPromise();

          const observerError = observer?.error;
          observerError && observerError(error);
        },
        complete: () => {
          resolveNetworkPromise();

          const observerComplete = observer?.complete;
          observerComplete && observerComplete();
        },
        unsubscribe: subscription => {
          this._cache.delete(cacheKey);
          const observerUnsubscribe = observer?.unsubscribe;
          observerUnsubscribe && observerUnsubscribe(subscription);
        },
      });

      let cacheEntry = this._cache.get(cacheKey);
      if (!cacheEntry) {
        const networkPromise = new Promise(resolve => {
          resolveNetworkPromise = resolve;
        });

        // $FlowExpectedError Expando to annotate Promises.
        networkPromise.displayName =
          'Relay(' + operation.fragment.node.name + ')';

        cacheEntry = createQueryResourceCacheEntry(
          cacheKey,
          operation,
          networkPromise,
          this._onDispose,
        );
        this._cache.set(cacheKey, cacheEntry);
      }
    } else {
      const observerComplete = observer?.complete;
      observerComplete && observerComplete();
    }
    const cacheEntry = this._cache.get(cacheKey);
    invariant(
      cacheEntry != null,
      'Relay: Expected to have cached a result when attempting to fetch query.' +
        "If you're seeing this, this is likely a bug in Relay.",
    );
    return cacheEntry;
  }
}

function createQueryResource(environment: IEnvironment): QueryResource {
  return new QueryResourceImpl(environment);
}

const dataResources: Map<IEnvironment, QueryResource> = new Map();
function getQueryResourceForEnvironment(
  environment: IEnvironment,
): QueryResourceImpl {
  const cached = dataResources.get(environment);
  if (cached) {
    return cached;
  }
  const newDataResource = createQueryResource(environment);
  dataResources.set(environment, newDataResource);
  return newDataResource;
}

module.exports = {
  createQueryResource,
  getQueryResourceForEnvironment,
};
