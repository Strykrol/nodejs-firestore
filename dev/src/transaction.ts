/*!
 * Copyright 2017 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as firestore from '@google-cloud/firestore';

import {GoogleError, Status} from 'google-gax';

import * as proto from '../protos/firestore_v1_proto_api';

import {ExponentialBackoff} from './backoff';
import {DocumentSnapshot} from './document';
import {Firestore, WriteBatch} from './index';
import {logger} from './logger';
import {FieldPath, validateFieldPath} from './path';
import {
  DocumentReference,
  Query,
  QuerySnapshot,
  validateDocumentReference,
} from './reference';
import {isObject, isPlainObject} from './util';
import {
  invalidArgumentMessage,
  RequiredArgumentOptions,
  validateMinNumberOfArguments,
  validateOptional,
} from './validate';

import api = proto.google.firestore.v1;

/*!
 * Error message for transactional reads that were executed after performing
 * writes.
 */
const READ_AFTER_WRITE_ERROR_MSG =
  'Firestore transactions require all reads to be executed before all writes.';

/**
 * A reference to a transaction.
 *
 * The Transaction object passed to a transaction's updateFunction provides
 * the methods to read and write data within the transaction context. See
 * [runTransaction()]{@link Firestore#runTransaction}.
 *
 * @class Transaction
 */
export class Transaction implements firestore.Transaction {
  private _firestore: Firestore;
  private _writeBatch: WriteBatch;
  private _backoff: ExponentialBackoff;
  private _requestTag: string;
  private _transactionId?: Uint8Array;

  /**
   * @hideconstructor
   *
   * @param firestore The Firestore Database client.
   * @param requestTag A unique client-assigned identifier for the scope of
   * this transaction.
   */
  constructor(firestore: Firestore, requestTag: string) {
    this._firestore = firestore;
    this._writeBatch = firestore.batch();
    this._requestTag = requestTag;
    this._backoff = new ExponentialBackoff();
  }

  /**
   * Retrieves a query result. Holds a pessimistic lock on all returned
   * documents.
   *
   * @param {Query} query A query to execute.
   * @return {Promise<QuerySnapshot>} A QuerySnapshot for the retrieved data.
   */
  get<T>(query: Query<T>): Promise<QuerySnapshot<T>>;

  /**
   * Reads the document referenced by the provided `DocumentReference.`
   * Holds a pessimistic lock on the returned document.
   *
   * @param {DocumentReference} documentRef A reference to the document to be read.
   * @return {Promise<DocumentSnapshot>}  A DocumentSnapshot for the read data.
   */
  get<T>(documentRef: DocumentReference<T>): Promise<DocumentSnapshot<T>>;

  /**
   * Retrieve a document or a query result from the database. Holds a
   * pessimistic lock on all returned documents.
   *
   * @param {DocumentReference|Query} refOrQuery The document or query to
   * return.
   * @returns {Promise} A Promise that resolves with a DocumentSnapshot or
   * QuerySnapshot for the returned documents.
   *
   * @example
   * firestore.runTransaction(transaction => {
   *   let documentRef = firestore.doc('col/doc');
   *   return transaction.get(documentRef).then(doc => {
   *     if (doc.exists) {
   *       transaction.update(documentRef, { count: doc.get('count') + 1 });
   *     } else {
   *       transaction.create(documentRef, { count: 1 });
   *     }
   *   });
   * });
   */
  get<T>(
    refOrQuery: DocumentReference<T> | Query<T>
  ): Promise<DocumentSnapshot<T> | QuerySnapshot<T>> {
    if (!this._writeBatch.isEmpty) {
      throw new Error(READ_AFTER_WRITE_ERROR_MSG);
    }

    if (refOrQuery instanceof DocumentReference) {
      return this._firestore
        .getAll_(
          [refOrQuery],
          /* fieldMask= */ null,
          this._requestTag,
          this._transactionId
        )
        .then(res => {
          return Promise.resolve(res[0]);
        });
    }

    if (refOrQuery instanceof Query) {
      return refOrQuery._get(this._transactionId);
    }

    throw new Error(
      'Value for argument "refOrQuery" must be a DocumentReference or a Query.'
    );
  }

  /**
   * Retrieves multiple documents from Firestore. Holds a pessimistic lock on
   * all returned documents.
   *
   * The first argument is required and must be of type `DocumentReference`
   * followed by any additional `DocumentReference` documents. If used, the
   * optional `ReadOptions` must be the last argument.
   *
   * @param {...DocumentReference|ReadOptions} documentRefsOrReadOptions The
   * `DocumentReferences` to receive, followed by an optional field mask.
   * @returns {Promise<Array.<DocumentSnapshot>>} A Promise that
   * contains an array with the resulting document snapshots.
   *
   * @example
   * let firstDoc = firestore.doc('col/doc1');
   * let secondDoc = firestore.doc('col/doc2');
   * let resultDoc = firestore.doc('col/doc3');
   *
   * firestore.runTransaction(transaction => {
   *   return transaction.getAll(firstDoc, secondDoc).then(docs => {
   *     transaction.set(resultDoc, {
   *       sum: docs[0].get('count') + docs[1].get('count')
   *     });
   *   });
   * });
   */
  getAll<T>(
    ...documentRefsOrReadOptions: Array<
      firestore.DocumentReference<T> | firestore.ReadOptions
    >
  ): Promise<Array<DocumentSnapshot<T>>> {
    if (!this._writeBatch.isEmpty) {
      throw new Error(READ_AFTER_WRITE_ERROR_MSG);
    }

    validateMinNumberOfArguments(
      'Transaction.getAll',
      documentRefsOrReadOptions,
      1
    );

    const {documents, fieldMask} = parseGetAllArguments(
      documentRefsOrReadOptions
    );

    return this._firestore.getAll_(
      documents,
      fieldMask,
      this._requestTag,
      this._transactionId
    );
  }

  /**
   * Create the document referred to by the provided
   * [DocumentReference]{@link DocumentReference}. The operation will
   * fail the transaction if a document exists at the specified location.
   *
   * @param {DocumentReference} documentRef A reference to the document to be
   * created.
   * @param {DocumentData} data The object data to serialize as the document.
   * @returns {Transaction} This Transaction instance. Used for
   * chaining method calls.
   *
   * @example
   * firestore.runTransaction(transaction => {
   *   let documentRef = firestore.doc('col/doc');
   *   return transaction.get(documentRef).then(doc => {
   *     if (!doc.exists) {
   *       transaction.create(documentRef, { foo: 'bar' });
   *     }
   *   });
   * });
   */
  create<T>(documentRef: firestore.DocumentReference<T>, data: T): Transaction {
    this._writeBatch.create(documentRef, data);
    return this;
  }

  set<T>(
    documentRef: firestore.DocumentReference<T>,
    data: Partial<T>,
    options: firestore.SetOptions
  ): Transaction;
  set<T>(documentRef: firestore.DocumentReference<T>, data: T): Transaction;
  /**
   * Writes to the document referred to by the provided
   * [DocumentReference]{@link DocumentReference}. If the document
   * does not exist yet, it will be created. If you pass
   * [SetOptions]{@link SetOptions}, the provided data can be merged into the
   * existing document.
   *
   * @param {DocumentReference} documentRef A reference to the document to be
   * set.
   * @param {T|Partial<T>} data The object to serialize as the document.
   * @param {SetOptions=} options An object to configure the set behavior.
   * @param {boolean=} options.merge - If true, set() merges the values
   * specified in its data argument. Fields omitted from this set() call
   * remain untouched.
   * @param {Array.<string|FieldPath>=} options.mergeFields - If provided,
   * set() only replaces the specified field paths. Any field path that is not
   * specified is ignored and remains untouched.
   * @returns {Transaction} This Transaction instance. Used for
   * chaining method calls.
   *
   * @example
   * firestore.runTransaction(transaction => {
   *   let documentRef = firestore.doc('col/doc');
   *   transaction.set(documentRef, { foo: 'bar' });
   *   return Promise.resolve();
   * });
   */
  set<T>(
    documentRef: firestore.DocumentReference<T>,
    data: T | Partial<T>,
    options?: firestore.SetOptions
  ): Transaction {
    this._writeBatch.set(documentRef, data, options);
    return this;
  }

  /**
   * Updates fields in the document referred to by the provided
   * [DocumentReference]{@link DocumentReference}. The update will
   * fail if applied to a document that does not exist.
   *
   * The update() method accepts either an object with field paths encoded as
   * keys and field values encoded as values, or a variable number of arguments
   * that alternate between field paths and field values. Nested fields can be
   * updated by providing dot-separated field path strings or by providing
   * FieldPath objects.
   *
   * A Precondition restricting this update can be specified as the last
   * argument.
   *
   * @param {DocumentReference} documentRef A reference to the document to be
   * updated.
   * @param {UpdateData|string|FieldPath} dataOrField An object
   * containing the fields and values with which to update the document
   * or the path of the first field to update.
   * @param {
   * ...(Precondition|*|string|FieldPath)} preconditionOrValues -
   * An alternating list of field paths and values to update or a Precondition
   * to to enforce on this update.
   * @returns {Transaction} This Transaction instance. Used for
   * chaining method calls.
   *
   * @example
   * firestore.runTransaction(transaction => {
   *   let documentRef = firestore.doc('col/doc');
   *   return transaction.get(documentRef).then(doc => {
   *     if (doc.exists) {
   *       transaction.update(documentRef, { count: doc.get('count') + 1 });
   *     } else {
   *       transaction.create(documentRef, { count: 1 });
   *     }
   *   });
   * });
   */
  update<T>(
    documentRef: firestore.DocumentReference<T>,
    dataOrField: firestore.UpdateData | string | firestore.FieldPath,
    ...preconditionOrValues: Array<
      firestore.Precondition | unknown | string | firestore.FieldPath
    >
  ): Transaction {
    // eslint-disable-next-line prefer-rest-params
    validateMinNumberOfArguments('Transaction.update', arguments, 2);

    this._writeBatch.update(documentRef, dataOrField, ...preconditionOrValues);
    return this;
  }

  /**
   * Deletes the document referred to by the provided [DocumentReference]
   * {@link DocumentReference}.
   *
   * @param {DocumentReference} documentRef A reference to the document to be
   * deleted.
   * @param {Precondition=} precondition A precondition to enforce for this
   * delete.
   * @param {Timestamp=} precondition.lastUpdateTime If set, enforces that the
   * document was last updated at lastUpdateTime. Fails the transaction if the
   * document doesn't exist or was last updated at a different time.
   * @param {boolean=} precondition.exists If set, enforces that the target
   * document must or must not exist.
   * @returns {Transaction} This Transaction instance. Used for
   * chaining method calls.
   *
   * @example
   * firestore.runTransaction(transaction => {
   *   let documentRef = firestore.doc('col/doc');
   *   transaction.delete(documentRef);
   *   return Promise.resolve();
   * });
   */
  delete<T>(
    documentRef: DocumentReference<T>,
    precondition?: firestore.Precondition
  ): this {
    this._writeBatch.delete(documentRef, precondition);
    return this;
  }

  /**
   * Starts a transaction and obtains the transaction id from the server.
   *
   * @private
   */
  begin(): Promise<void> {
    const request: api.IBeginTransactionRequest = {
      database: this._firestore.formattedName,
    };

    if (this._transactionId) {
      request.options = {
        readWrite: {
          retryTransaction: this._transactionId,
        },
      };
    }

    return this._firestore
      .request<api.IBeginTransactionRequest, api.IBeginTransactionResponse>(
        'beginTransaction',
        request,
        this._requestTag
      )
      .then(resp => {
        this._transactionId = resp.transaction!;
      });
  }

  /**
   * Commits all queued-up changes in this transaction and releases all locks.
   *
   * @private
   */
  commit(): Promise<void> {
    return this._writeBatch
      ._commit({
        transactionId: this._transactionId,
        requestTag: this._requestTag,
      })
      .then(() => {});
  }

  /**
   * Releases all locks and rolls back this transaction.
   *
   * @private
   */
  rollback(): Promise<void> {
    const request = {
      database: this._firestore.formattedName,
      transaction: this._transactionId,
    };

    return this._firestore.request('rollback', request, this._requestTag);
  }

  /**
   * Executes `updateFunction()` and commits the transaction with retry.
   *
   * @private
   * @param updateFunction The user function to execute within the transaction
   * context.
   * @param requestTag A unique client-assigned identifier for the scope of
   * this transaction.
   * @param maxAttempts The maximum number of attempts for this transaction.
   */
  async runTransaction<T>(
    updateFunction: (transaction: Transaction) => Promise<T>,
    maxAttempts: number
  ): Promise<T> {
    let result: T;
    let lastError: GoogleError | undefined = undefined;

    for (let attempt = 0; attempt < maxAttempts; ++attempt) {
      try {
        if (lastError) {
          logger(
            'Firestore.runTransaction',
            this._requestTag,
            'Retrying transaction after error:',
            lastError
          );
          await this.rollback();
        }

        this._writeBatch._reset();
        await this.maybeBackoff(lastError);

        await this.begin();

        const promise = updateFunction(this);
        if (!(promise instanceof Promise)) {
          throw new Error(
            'You must return a Promise in your transaction()-callback.'
          );
        }
        result = await promise;
        await this.commit();
        return result;
      } catch (err) {
        logger(
          'Firestore.runTransaction',
          this._requestTag,
          'Rolling back transaction after callback error:',
          err
        );

        lastError = err;

        if (!this._transactionId || !isRetryableTransactionError(err)) {
          break;
        }
      }
    }

    logger(
      'Firestore.runTransaction',
      this._requestTag,
      'Transaction not eligible for retry, returning error: %s',
      lastError
    );

    await this.rollback();
    return Promise.reject(lastError);
  }

  /**
   * Delays further operations based on the provided error.
   *
   * @private
   * @return A Promise that resolves after the delay expired.
   */
  private async maybeBackoff(error?: GoogleError): Promise<void> {
    if (error && error.code === Status.RESOURCE_EXHAUSTED) {
      this._backoff.resetToMax();
    }
    await this._backoff.backoffAndWait();
  }
}

/**
 * Parses the arguments for the `getAll()` call supported by both the Firestore
 * and Transaction class.
 *
 * @private
 * @param documentRefsOrReadOptions An array of document references followed by
 * an optional ReadOptions object.
 */
export function parseGetAllArguments<T>(
  documentRefsOrReadOptions: Array<
    firestore.DocumentReference<T> | firestore.ReadOptions
  >
): {documents: Array<DocumentReference<T>>; fieldMask: FieldPath[] | null} {
  let documents: Array<DocumentReference<T>>;
  let readOptions: firestore.ReadOptions | undefined = undefined;

  if (Array.isArray(documentRefsOrReadOptions[0])) {
    throw new Error(
      'getAll() no longer accepts an array as its first argument. ' +
        'Please unpack your array and call getAll() with individual arguments.'
    );
  }

  if (
    documentRefsOrReadOptions.length > 0 &&
    isPlainObject(
      documentRefsOrReadOptions[documentRefsOrReadOptions.length - 1]
    )
  ) {
    readOptions = documentRefsOrReadOptions.pop() as firestore.ReadOptions;
    documents = documentRefsOrReadOptions as Array<DocumentReference<T>>;
  } else {
    documents = documentRefsOrReadOptions as Array<DocumentReference<T>>;
  }

  for (let i = 0; i < documents.length; ++i) {
    validateDocumentReference(i, documents[i]);
  }

  validateReadOptions('options', readOptions, {optional: true});
  const fieldMask =
    readOptions && readOptions.fieldMask
      ? readOptions.fieldMask.map(fieldPath =>
          FieldPath.fromArgument(fieldPath)
        )
      : null;
  return {fieldMask, documents};
}

/**
 * Validates the use of 'options' as ReadOptions and enforces that 'fieldMask'
 * is an array of strings or field paths.
 *
 * @private
 * @param arg The argument name or argument index (for varargs methods).
 * @param value The input to validate.
 * @param options Options that specify whether the ReadOptions can be omitted.
 */
function validateReadOptions(
  arg: number | string,
  value: unknown,
  options?: RequiredArgumentOptions
): void {
  if (!validateOptional(value, options)) {
    if (!isObject(value)) {
      throw new Error(
        `${invalidArgumentMessage(arg, 'read option')} Input is not an object.'`
      );
    }

    const options = value as {[k: string]: unknown};

    if (options.fieldMask !== undefined) {
      if (!Array.isArray(options.fieldMask)) {
        throw new Error(
          `${invalidArgumentMessage(
            arg,
            'read option'
          )} "fieldMask" is not an array.`
        );
      }

      for (let i = 0; i < options.fieldMask.length; ++i) {
        try {
          validateFieldPath(i, options.fieldMask[i]);
        } catch (err) {
          throw new Error(
            `${invalidArgumentMessage(
              arg,
              'read option'
            )} "fieldMask" is not valid: ${err.message}`
          );
        }
      }
    }
  }
}

function isRetryableTransactionError(error: GoogleError): boolean {
  if (error.code !== undefined) {
    // This list is based on https://github.com/firebase/firebase-js-sdk/blob/master/packages/firestore/src/core/transaction_runner.ts#L112
    switch (error.code) {
      case Status.ABORTED:
      case Status.CANCELLED:
      case Status.UNKNOWN:
      case Status.DEADLINE_EXCEEDED:
      case Status.INTERNAL:
      case Status.UNAVAILABLE:
      case Status.UNAUTHENTICATED:
      case Status.RESOURCE_EXHAUSTED:
        return true;
      case Status.INVALID_ARGUMENT:
        // The Firestore backend uses "INVALID_ARGUMENT" for transactions
        // IDs that have expired. While INVALID_ARGUMENT is generally not
        // retryable, we retry this specific case.
        return !!error.message.match(/transaction has expired/);
      default:
        return false;
    }
  }
  return false;
}
