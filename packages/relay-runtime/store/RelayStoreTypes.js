/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 * @format
 */

'use strict';

import type {LoggerTransactionConfig} from '../network/RelayNetworkLoggerTransaction';
import type {
  GraphQLResponse,
  Network,
  PayloadData,
  PayloadError,
  UploadableMap,
} from '../network/RelayNetworkTypes';
import type RelayObservable from '../network/RelayObservable';
import type {
  NormalizationLinkedField,
  NormalizationScalarField,
  NormalizationSelectableNode,
  NormalizationSplitOperation,
} from '../util/NormalizationNode';
import type {ReaderFragment} from '../util/ReaderNode';
import type {ConcreteRequest} from '../util/RelayConcreteNode';
import type {
  CacheConfig,
  DataID,
  Disposable,
  Variables,
} from '../util/RelayRuntimeTypes';
import type {RequestIdentifier} from '../util/getRequestIdentifier';
import type {
  ConnectionID,
  ConnectionInternalEvent,
  ConnectionReference,
  ConnectionSnapshot,
} from './RelayConnection';
import type RelayOperationTracker from './RelayOperationTracker';
import type {RecordState} from './RelayRecordState';

export opaque type FragmentReference = empty;
export type OperationTracker = RelayOperationTracker;

/*
 * An individual cached graph object.
 */
export type Record = {[key: string]: mixed};

/**
 * A collection of records keyed by id.
 */
export type RecordMap = {[dataID: DataID]: ?Record};

export type FragmentMap = {[key: string]: ReaderFragment};

/**
 * The results of a selector given a store/RecordSource.
 */
export type SelectorData = {[key: string]: mixed};

export type SingularReaderSelector = {|
  +kind: 'SingularReaderSelector',
  +dataID: DataID,
  +node: ReaderFragment,
  +owner: RequestDescriptor,
  +variables: Variables,
|};

export type ReaderSelector = SingularReaderSelector | PluralReaderSelector;

export type PluralReaderSelector = {|
  +kind: 'PluralReaderSelector',
  +selectors: $ReadOnlyArray<SingularReaderSelector>,
|};

export type RequestDescriptor = {|
  +identifier: RequestIdentifier,
  +node: ConcreteRequest,
  +variables: Variables,
|};

/**
 * A selector defines the starting point for a traversal into the graph for the
 * purposes of targeting a subgraph.
 */
export type NormalizationSelector = {|
  +dataID: DataID,
  +node: NormalizationSelectableNode,
  +variables: Variables,
|};

/**
 * A representation of a selector and its results at a particular point in time.
 */
export type TypedSnapshot<TData> = {|
  +data: TData,
  +isMissingData: boolean,
  +seenRecords: RecordMap,
  +selector: SingularReaderSelector,
|};
export type Snapshot = TypedSnapshot<?SelectorData>;

/**
 * An operation selector describes a specific instance of a GraphQL operation
 * with variables applied.
 *
 * - `root`: a selector intended for processing server results or retaining
 *   response data in the store.
 * - `fragment`: a selector intended for use in reading or subscribing to
 *   the results of the the operation.
 */
export type OperationDescriptor = {|
  +fragment: SingularReaderSelector,
  +request: RequestDescriptor,
  +root: NormalizationSelector,
|};

/**
 * Arbitrary data e.g. received by a container as props.
 */
export type Props = {[key: string]: mixed};

/**
 * The type of the `relay` property set on React context by the React/Relay
 * integration layer (e.g. QueryRenderer, FragmentContainer, etc).
 */
export type RelayContext = {
  environment: Environment,
  variables: Variables,
};

/**
 * The results of reading the results of a FragmentMap given some input
 * `Props`.
 */
export type FragmentSpecResults = {[key: string]: mixed};

/**
 * A utility for resolving and subscribing to the results of a fragment spec
 * (key -> fragment mapping) given some "props" that determine the root ID
 * and variables to use when reading each fragment. When props are changed via
 * `setProps()`, the resolver will update its results and subscriptions
 * accordingly. Internally, the resolver:
 * - Converts the fragment map & props map into a map of `Selector`s.
 * - Removes any resolvers for any props that became null.
 * - Creates resolvers for any props that became non-null.
 * - Updates resolvers with the latest props.
 */
export interface FragmentSpecResolver {
  /**
   * Stop watching for changes to the results of the fragments.
   */
  dispose(): void;

  /**
   * Get the current results.
   */
  resolve(): FragmentSpecResults;

  /**
   * Update the resolver with new inputs. Call `resolve()` to get the updated
   * results.
   */
  setProps(props: Props): void;

  /**
   * Override the variables used to read the results of the fragments. Call
   * `resolve()` to get the updated results.
   */
  setVariables(variables: Variables, node: ConcreteRequest): void;

  /**
   * Subscribe to resolver updates.
   * Overrides existing callback (if one has been specified).
   */
  setCallback(callback: () => void): void;
}

/**
 * A read-only interface for accessing cached graph data.
 */
export interface RecordSource {
  get(dataID: DataID): ?Record;
  getRecordIDs(): Array<DataID>;
  getStatus(dataID: DataID): RecordState;
  has(dataID: DataID): boolean;
  size(): number;
  toJSON(): {[DataID]: ?Record};
}

/**
 * A read/write interface for accessing and updating graph data.
 */
export interface MutableRecordSource extends RecordSource {
  clear(): void;
  delete(dataID: DataID): void;
  remove(dataID: DataID): void;
  set(dataID: DataID, record: Record): void;
}

/**
 * An interface for keeping multiple views of data consistent across an
 * application.
 */
export interface Store {
  /**
   * Get a read-only view of the store's internal RecordSource.
   */
  getSource(): RecordSource;

  /**
   * Determine if the selector can be resolved with data in the store (i.e. no
   * fields are missing).
   */
  check(selector: NormalizationSelector): boolean;

  /**
   * Read the results of a selector from in-memory records in the store.
   * Optionally takes an owner, corresponding to the operation that
   * owns this selector (fragment).
   */
  lookup(selector: SingularReaderSelector): Snapshot;

  /**
   * Notify subscribers (see `subscribe`) of any data that was published
   * (`publish()`) since the last time `notify` was called.
   *
   * Also this method should return an array of the affected fragment owners
   */
  notify(): $ReadOnlyArray<RequestDescriptor>;

  /**
   * Publish new information (e.g. from the network) to the store, updating its
   * internal record source. Subscribers are not immediately notified - this
   * occurs when `notify()` is called.
   */
  publish(source: RecordSource): void;

  /**
   * Ensure that all the records necessary to fulfill the given selector are
   * retained in-memory. The records will not be eligible for garbage collection
   * until the returned reference is disposed.
   */
  retain(selector: NormalizationSelector): Disposable;

  /**
   * Subscribe to changes to the results of a selector. The callback is called
   * when `notify()` is called *and* records have been published that affect the
   * selector results relative to the last `notify()`.
   */
  subscribe(
    snapshot: Snapshot,
    callback: (snapshot: Snapshot) => void,
  ): Disposable;

  /**
   * The method should disable garbage collection until
   * the returned reference is disposed.
   */
  holdGC(): Disposable;

  lookupConnection_UNSTABLE<TEdge, TState>(
    connectionReference: ConnectionReference<TEdge, TState>,
  ): ConnectionSnapshot<TEdge, TState>;

  subscribeConnection_UNSTABLE<TEdge, TState>(
    snapshot: ConnectionSnapshot<TEdge, TState>,
    callback: (state: TState) => void,
  ): Disposable;

  /**
   * Publish connection events, updating the store's list of events. As with
   * publish(), subscribers are only notified after notify() is called.
   */
  publishConnectionEvents_UNSTABLE(
    events: Array<ConnectionInternalEvent>,
    final: boolean,
  ): void;

  /**
   * Get a read-only view of the store's internal connection events for a given
   * connection.
   */
  getConnectionEvents_UNSTABLE(
    connectionID: ConnectionID,
  ): ?$ReadOnlyArray<ConnectionInternalEvent>;

  /**
   * Record a backup/snapshot of the current state of the store, including
   * records and derived data such as fragment and connection subscriptions.
   * This state can be restored with restore().
   */
  snapshot(): void;

  /**
   * Reset the state of the store to the point that snapshot() was last called.
   */
  restore(): void;
}

/**
 * A type that accepts a callback and schedules it to run at some future time.
 * By convention, implementations should not execute the callback immediately.
 */
export type Scheduler = (() => void) => void;

/**
 * An interface for imperatively getting/setting properties of a `Record`. This interface
 * is designed to allow the appearance of direct Record manipulation while
 * allowing different implementations that may e.g. create a changeset of
 * the modifications.
 */
export interface RecordProxy {
  copyFieldsFrom(source: RecordProxy): void;
  getDataID(): DataID;
  getLinkedRecord(name: string, args?: ?Variables): ?RecordProxy;
  getLinkedRecords(name: string, args?: ?Variables): ?Array<?RecordProxy>;
  getOrCreateLinkedRecord(
    name: string,
    typeName: string,
    args?: ?Variables,
  ): RecordProxy;
  getType(): string;
  getValue(name: string, args?: ?Variables): mixed;
  setLinkedRecord(
    record: RecordProxy,
    name: string,
    args?: ?Variables,
  ): RecordProxy;
  setLinkedRecords(
    records: Array<?RecordProxy>,
    name: string,
    args?: ?Variables,
  ): RecordProxy;
  setValue(value: mixed, name: string, args?: ?Variables): RecordProxy;
}

export interface ReadOnlyRecordProxy {
  getDataID(): DataID;
  getLinkedRecord(name: string, args?: ?Variables): ?RecordProxy;
  getLinkedRecords(name: string, args?: ?Variables): ?Array<?RecordProxy>;
  getType(): string;
  getValue(name: string, args?: ?Variables): mixed;
}

/**
 * An interface for imperatively getting/setting properties of a `RecordSource`. This interface
 * is designed to allow the appearance of direct RecordSource manipulation while
 * allowing different implementations that may e.g. create a changeset of
 * the modifications.
 */
export interface RecordSourceProxy {
  create(dataID: DataID, typeName: string): RecordProxy;
  delete(dataID: DataID): void;
  get(dataID: DataID): ?RecordProxy;
  getRoot(): RecordProxy;
}

export interface ReadOnlyRecordSourceProxy {
  get(dataID: DataID): ?ReadOnlyRecordProxy;
  getRoot(): ReadOnlyRecordProxy;
}

/**
 * Extends the RecordSourceProxy interface with methods for accessing the root
 * fields of a Selector.
 */
export interface RecordSourceSelectorProxy extends RecordSourceProxy {
  getRootField(fieldName: string): ?RecordProxy;
  getPluralRootField(fieldName: string): ?Array<?RecordProxy>;
  insertConnectionEdge_UNSTABLE(
    connectionID: ConnectionID,
    args: Variables,
    edge: RecordProxy,
  ): void;
}

export interface Logger {
  log(message: string, ...values: Array<mixed>): void;
  flushLogs(): void;
}

export interface LoggerProvider {
  getLogger(config: LoggerTransactionConfig): Logger;
}

/**
 * The public API of Relay core. Represents an encapsulated environment with its
 * own in-memory cache.
 */
export interface Environment {
  /**
   * Determine if the selector can be resolved with data in the store (i.e. no
   * fields are missing).
   *
   * Note that this operation effectively "executes" the selector against the
   * cache and therefore takes time proportional to the size/complexity of the
   * selector.
   */
  check(selector: NormalizationSelector): boolean;

  /**
   * Subscribe to changes to the results of a selector. The callback is called
   * when data has been committed to the store that would cause the results of
   * the snapshot's selector to change.
   */
  subscribe(
    snapshot: Snapshot,
    callback: (snapshot: Snapshot) => void,
  ): Disposable;

  /**
   * Ensure that all the records necessary to fulfill the given selector are
   * retained in-memory. The records will not be eligible for garbage collection
   * until the returned reference is disposed.
   */
  retain(selector: NormalizationSelector): Disposable;

  /**
   * Apply an optimistic update to the environment. The mutation can be reverted
   * by calling `dispose()` on the returned value.
   */
  applyUpdate(optimisticUpdate: OptimisticUpdateFunction): Disposable;

  /**
   * Apply an optimistic mutation response and/or updater. The mutation can be
   * reverted by calling `dispose()` on the returned value.
   */
  applyMutation(optimisticConfig: OptimisticResponseConfig): Disposable;

  /**
   * Commit an updater to the environment. This mutation cannot be reverted and
   * should therefore not be used for optimistic updates. This is mainly
   * intended for updating fields from client schema extensions.
   */
  commitUpdate(updater: StoreUpdater): void;

  /**
   * Commit a payload to the environment using the given operation selector.
   */
  commitPayload(
    operationDescriptor: OperationDescriptor,
    payload: PayloadData,
  ): void;

  /**
   * Get the environment's internal Network.
   */
  getNetwork(): Network;

  /**
   * Get the environment's internal Store.
   */
  getStore(): Store;

  /**
   * Get an instance of a logger
   */
  getLogger(config: LoggerTransactionConfig): ?Logger;

  /**
   * Returns the environment specific OperationTracker.
   */
  getOperationTracker(): RelayOperationTracker;

  /**
   * Read the results of a selector from in-memory records in the store.
   * Optionally takes an owner, corresponding to the operation that
   * owns this selector (fragment).
   */
  lookup(selector: SingularReaderSelector): Snapshot;

  /**
   * Send a query to the server with Observer semantics: one or more
   * responses may be returned (via `next`) over time followed by either
   * the request completing (`completed`) or an error (`error`).
   *
   * Networks/servers that support subscriptions may choose to hold the
   * subscription open indefinitely such that `complete` is not called.
   *
   * Note: Observables are lazy, so calling this method will do nothing until
   * the result is subscribed to: environment.execute({...}).subscribe({...}).
   */
  execute(config: {|
    operation: OperationDescriptor,
    cacheConfig?: ?CacheConfig,
    updater?: ?SelectorStoreUpdater,
  |}): RelayObservable<GraphQLResponse>;

  /**
   * Returns an Observable of GraphQLResponse resulting from executing the
   * provided Mutation operation, the result of which is then normalized and
   * committed to the publish queue along with an optional optimistic response
   * or updater.
   *
   * Note: Observables are lazy, so calling this method will do nothing until
   * the result is subscribed to:
   * environment.executeMutation({...}).subscribe({...}).
   */
  executeMutation({|
    operation: OperationDescriptor,
    optimisticUpdater?: ?SelectorStoreUpdater,
    optimisticResponse?: ?Object,
    updater?: ?SelectorStoreUpdater,
    uploadables?: ?UploadableMap,
  |}): RelayObservable<GraphQLResponse>;

  /**
   * Returns an Observable of GraphQLResponse resulting from executing the
   * provided Query or Subscription operation responses, the result of which is
   * then normalized and comitted to the publish queue.
   *
   * Note: Observables are lazy, so calling this method will do nothing until
   * the result is subscribed to:
   * environment.executeWithSource({...}).subscribe({...}).
   */
  executeWithSource({|
    operation: OperationDescriptor,
    source: RelayObservable<GraphQLResponse>,
  |}): RelayObservable<GraphQLResponse>;
}

/**
 * The results of reading data for a fragment. This is similar to a `Selector`,
 * but references the (fragment) node by name rather than by value.
 */
export type FragmentPointer = {
  __id: DataID,
  __fragments: {[fragmentName: string]: Variables},
  __fragmentOwner: RequestDescriptor,
};

/**
 * The partial shape of an object with a '...Fragment @module(name: "...")'
 * selection
 */
export type ModuleImportPointer = {
  +__fragmentPropName: ?string,
  +__module_component: mixed,
  +$fragmentRefs: mixed,
};

/**
 * A callback for resolving a Selector from a source.
 */
export type AsyncLoadCallback = (loadingState: LoadingState) => void;
export type LoadingState = $Exact<{
  status: 'aborted' | 'complete' | 'error' | 'missing',
  error?: Error,
}>;

/**
 * A map of records affected by an update operation.
 */
export type UpdatedRecords = {[dataID: DataID]: boolean};

/**
 * A function that updates a store (via a proxy) given the results of a "handle"
 * field payload.
 */
export type Handler = {
  update: (store: RecordSourceProxy, fieldPayload: HandleFieldPayload) => void,
};

/**
 * A payload that is used to initialize or update a "handle" field with
 * information from the server.
 */
export type HandleFieldPayload = {|
  // The arguments that were fetched.
  +args: Variables,
  // The __id of the record containing the source/handle field.
  +dataID: DataID,
  // The (storage) key at which the original server data was written.
  +fieldKey: string,
  // The name of the handle.
  +handle: string,
  // The (storage) key at which the handle's data should be written by the
  // handler.
  +handleKey: string,
|};

/**
 * A payload that represents data necessary to process the results of an object
 * with a `@module` fragment spread:
 * - data: The GraphQL response value for the @match field.
 * - dataID: The ID of the store object linked to by the @match field.
 * - operationReference: A reference to a generated module containing the
 *   SplitOperation with which to normalize the field's `data`.
 * - variables: Query variables.
 * - typeName: the type that matched.
 *
 * The dataID, variables, and fragmentName can be used to create a Selector
 * which can in turn be used to normalize and publish the data. The dataID and
 * typeName can also be used to construct a root record for normalization.
 */
export type ModuleImportPayload = {|
  +data: PayloadData,
  +dataID: DataID,
  +operationReference: mixed,
  +path: $ReadOnlyArray<string>,
  +typeName: string,
  +variables: Variables,
|};

/**
 * Data emitted after processing a Defer or Stream node during normalization
 * that describes how to process the corresponding response chunk when it
 * arrives.
 */
export type DeferPlaceholder = {|
  +kind: 'defer',
  +data: PayloadData,
  +label: string,
  +path: $ReadOnlyArray<string>,
  +selector: NormalizationSelector,
  +typeName: string,
|};
export type StreamPlaceholder = {|
  +kind: 'stream',
  +label: string,
  +path: $ReadOnlyArray<string>,
  +parentID: DataID,
  +node: NormalizationSelectableNode,
  +variables: Variables,
|};
export type IncrementalDataPlaceholder = DeferPlaceholder | StreamPlaceholder;

/**
 * A user-supplied object to load a generated operation (SplitOperation) AST
 * by a module reference. The exact format of a module reference is left to
 * the application, but it must be a plain JavaScript value (string, number,
 * or object/array of same).
 */
export type OperationLoader = {|
  /**
   * Synchronously load an operation, returning either the node or null if it
   * cannot be resolved synchronously.
   */
  get(reference: mixed): ?NormalizationSplitOperation,

  /**
   * Asynchronously load an operation.
   */
  load(reference: mixed): Promise<?NormalizationSplitOperation>,
|};

/**
 * A function that receives a proxy over the store and may trigger side-effects
 * (indirectly) by calling `set*` methods on the store or its record proxies.
 */
export type StoreUpdater = (store: RecordSourceProxy) => void;

/**
 * Similar to StoreUpdater, but accepts a proxy tied to a specific selector in
 * order to easily access the root fields of a query/mutation as well as a
 * second argument of the response object of the mutation.
 */
export type SelectorStoreUpdater = (
  store: RecordSourceSelectorProxy,
  // Actually SelectorData, but mixed is inconvenient to access deeply in
  // product code.
  data: $FlowFixMe,
) => void;

/**
 * A set of configs that can be used to apply an optimistic update into the
 * store.
 */
export type OptimisticUpdate =
  | OptimisticUpdateFunction
  | OptimisticUpdateRelayPayload;

export type OptimisticUpdateFunction = {|
  +storeUpdater: StoreUpdater,
|};

export type OptimisticUpdateRelayPayload = {|
  +operation: OperationDescriptor,
  +payload: RelayResponsePayload,
  +updater: ?SelectorStoreUpdater,
|};

export type OptimisticResponseConfig = {|
  +operation: OperationDescriptor,
  +response: ?PayloadData,
  +updater: ?SelectorStoreUpdater,
|};

/**
 * A set of handlers that can be used to provide substitute data for missing
 * fields when reading a selector from a source.
 */
export type MissingFieldHandler =
  | {
      kind: 'scalar',
      handle: (
        field: NormalizationScalarField,
        record: ?Record,
        args: Variables,
        store: ReadOnlyRecordSourceProxy,
      ) => mixed,
    }
  | {
      kind: 'linked',
      handle: (
        field: NormalizationLinkedField,
        record: ?Record,
        args: Variables,
        store: ReadOnlyRecordSourceProxy,
      ) => ?DataID,
    }
  | {
      kind: 'pluralLinked',
      handle: (
        field: NormalizationLinkedField,
        record: ?Record,
        args: Variables,
        store: ReadOnlyRecordSourceProxy,
      ) => ?Array<?DataID>,
    };

/**
 * The results of normalizing a query.
 */
export type RelayResponsePayload = {|
  +connectionEvents: ?Array<ConnectionInternalEvent>,
  +errors: ?Array<PayloadError>,
  +fieldPayloads: ?Array<HandleFieldPayload>,
  +incrementalPlaceholders: ?Array<IncrementalDataPlaceholder>,
  +moduleImportPayloads: ?Array<ModuleImportPayload>,
  +source: MutableRecordSource,
|};

/**
 * Public interface for Publish Queue
 */
export interface PublishQueue {
  /**
   * Schedule applying an optimistic updates on the next `run()`.
   */
  applyUpdate(updater: OptimisticUpdate): void;

  /**
   * Schedule reverting an optimistic updates on the next `run()`.
   */
  revertUpdate(updater: OptimisticUpdate): void;

  /**
   * Schedule a revert of all optimistic updates on the next `run()`.
   */
  revertAll(): void;

  /**
   * Schedule applying a payload to the store on the next `run()`.
   */
  commitPayload(
    operation: OperationDescriptor,
    payload: RelayResponsePayload,
    updater?: ?SelectorStoreUpdater,
  ): void;

  /**
   * Schedule an updater to mutate the store on the next `run()` typically to
   * update client schema fields.
   */
  commitUpdate(updater: StoreUpdater): void;

  /**
   * Schedule a publish to the store from the provided source on the next
   * `run()`. As an example, to update the store with substituted fields that
   * are missing in the store.
   */
  commitSource(source: RecordSource): void;

  /**
   * Execute all queued up operations from the other public methods.
   */
  run(): $ReadOnlyArray<RequestDescriptor>;
}
