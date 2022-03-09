import { Request, Headers } from 'node-fetch';
import type {
  default as GraphQLOptions,
  GraphQLServerOptions,
} from './graphqlOptions';
import { ApolloError, formatApolloErrors } from './errors';
import {
  processGraphQLRequest,
  GraphQLRequest,
  GraphQLRequestContext,
  GraphQLResponse,
} from './requestPipeline';
import type {
  GraphQLExecutionResult,
  BaseContext,
  HTTPGraphQLRequest,
  HTTPGraphQLResponse,
} from '@apollo/server-types';
import { newCachePolicy } from './cachePolicy';

export interface HttpQueryRequest<TContext extends BaseContext> {
  method: string;
  // query is either the POST body or the GET query string map.  In the GET
  // case, all values are strings and need to be parsed as JSON; in the POST
  // case they should already be parsed. query has keys like 'query' (whose
  // value should always be a string), 'variables', 'operationName',
  // 'extensions', etc.
  query: Record<string, any> | Array<Record<string, any>>;
  options: GraphQLOptions<TContext>;
  context: TContext;
  request: Pick<Request, 'url' | 'method' | 'headers'>;
}

interface ApolloServerHttpResponse {
  headers?: Record<string, string>;
  status?: number;
  // ResponseInit contains the follow, which we do not use
  // statusText?: string;
}

interface HttpQueryResponse {
  // TODO: This isn't actually an individual GraphQL response, but the body
  // of the HTTP response, which could contain multiple GraphQL responses
  // when using batching.
  graphqlResponse: string;
  responseInit: ApolloServerHttpResponse;
}

export class HttpQueryError extends Error {
  public statusCode: number;
  public isGraphQLError: boolean;
  public headers?: { [key: string]: string };

  constructor(
    statusCode: number,
    message: string,
    isGraphQLError: boolean = false,
    headers?: { [key: string]: string },
  ) {
    super(message);
    this.name = 'HttpQueryError';
    this.statusCode = statusCode;
    this.isGraphQLError = isGraphQLError;
    this.headers = headers;
  }
}

export function isHttpQueryError(e: unknown): e is HttpQueryError {
  return (e as any)?.name === 'HttpQueryError';
}

/**
 * If options is specified, then the errors array will be formatted
 */
export function throwHttpGraphQLError<
  TContext extends BaseContext,
  E extends Error,
>(
  statusCode: number,
  errors: Array<E>,
  options?: Pick<GraphQLOptions<TContext>, 'debug' | 'formatError'>,
  extensions?: GraphQLExecutionResult['extensions'],
  headers?: Headers,
): never {
  const allHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (headers) {
    for (const [name, value] of headers) {
      allHeaders[name] = value;
    }
  }

  type Result = Pick<GraphQLExecutionResult, 'extensions'> & {
    errors: E[] | ApolloError[];
  };

  const result: Result = {
    errors: options
      ? formatApolloErrors(errors, {
          debug: options.debug,
          formatter: options.formatError,
        })
      : errors,
  };

  if (extensions) {
    result.extensions = extensions;
  }

  throw new HttpQueryError(
    statusCode,
    prettyJSONStringify(result),
    true,
    allHeaders,
  );
}

const NODE_ENV = process.env.NODE_ENV ?? '';

// TODO(AS4): this probably can be un-exported once we clean up context function
// error handling
export function debugFromNodeEnv(nodeEnv: string = NODE_ENV) {
  return nodeEnv !== 'production' && nodeEnv !== 'test';
}

function fieldIfString(
  o: Record<string, any>,
  fieldName: string,
): string | undefined {
  if (typeof o[fieldName] === 'string') {
    return o[fieldName];
  }
  return undefined;
}

function jsonParsedFieldIfNonEmptyString(
  o: Record<string, any>,
  fieldName: string,
): Record<string, any> | undefined {
  if (typeof o[fieldName] === 'string' && o[fieldName]) {
    let hopefullyRecord;
    try {
      hopefullyRecord = JSON.parse(o[fieldName]);
    } catch {
      throw new HttpQueryError(
        400,
        `The ${fieldName} search parameter contains invalid JSON.`,
      );
    }
    if (!isStringRecord(hopefullyRecord)) {
      throw new HttpQueryError(
        400,
        `The ${fieldName} search parameter should contain a JSON-encoded object.`,
      );
    }
    return hopefullyRecord;
  }
  return undefined;
}

function fieldIfRecord(
  o: Record<string, any>,
  fieldName: string,
): Record<string, any> | undefined {
  if (isStringRecord(o[fieldName])) {
    return o[fieldName];
  }
  return undefined;
}

function isStringRecord(o: any): o is Record<string, any> {
  return o && typeof o === 'object' && !Buffer.isBuffer(o) && !Array.isArray(o);
}

function isNonEmptyStringRecord(o: any): o is Record<string, any> {
  return isStringRecord(o) && Object.keys(o).length > 0;
}

function ensureQueryIsStringOrMissing(query: any) {
  if (!query || typeof query === 'string') {
    return;
  }
  // Check for a common error first.
  if (query.kind === 'Document') {
    throw new HttpQueryError(
      400,
      "GraphQL queries must be strings. It looks like you're sending the " +
        'internal graphql-js representation of a parsed query in your ' +
        'request instead of a request in the GraphQL query language. You ' +
        'can convert an AST to a string using the `print` function from ' +
        '`graphql`, or use a client like `apollo-client` which converts ' +
        'the internal representation to a string for you.',
    );
  } else {
    throw new HttpQueryError(400, 'GraphQL queries must be strings.');
  }
}

export async function runHttpQuery<TContext extends BaseContext>(
  httpRequest: HTTPGraphQLRequest,
  context: TContext,
  options: GraphQLServerOptions<TContext>,
): Promise<HTTPGraphQLResponse> {
  if (options.debug === undefined) {
    options.debug = debugFromNodeEnv(options.nodeEnv);
  }

  let graphqlRequest: GraphQLRequest;

  switch (httpRequest.method) {
    case 'POST':
      if (!isNonEmptyStringRecord(httpRequest.body)) {
        throw new HttpQueryError(
          400,
          'POST body missing, invalid Content-Type, or JSON object has no keys.',
        );
      }

      ensureQueryIsStringOrMissing(httpRequest.body.query);

      graphqlRequest = {
        query: fieldIfString(httpRequest.body, 'query'),
        operationName: fieldIfString(httpRequest.body, 'operationName'),
        variables: fieldIfRecord(httpRequest.body, 'variables'),
        extensions: fieldIfRecord(httpRequest.body, 'extensions'),
        http: httpRequest,
      };

      break;
    case 'GET':
      if (!isNonEmptyStringRecord(httpRequest.searchParams)) {
        throw new HttpQueryError(400, 'GET query missing.');
      }

      ensureQueryIsStringOrMissing(httpRequest.searchParams.query);

      graphqlRequest = {
        query: fieldIfString(httpRequest.searchParams, 'query'),
        operationName: fieldIfString(httpRequest.searchParams, 'operationName'),
        variables: jsonParsedFieldIfNonEmptyString(
          httpRequest.searchParams,
          'variables',
        ),
        extensions: jsonParsedFieldIfNonEmptyString(
          httpRequest.searchParams,
          'extensions',
        ),
        http: httpRequest,
      };

      break;
    default:
      throw new HttpQueryError(
        405,
        'Apollo Server supports only GET/POST requests.',
        false,
        {
          Allow: 'GET, POST',
        },
      );
  }

  const plugins = [...(options.plugins ?? [])];

  // GET operations should only be queries (not mutations). We want to throw
  // a particular HTTP error in that case.
  if (httpRequest.method === 'GET') {
    plugins.unshift({
      async requestDidStart() {
        return {
          async didResolveOperation({ operation }) {
            if (operation.operation !== 'query') {
              throw new HttpQueryError(
                405,
                `GET supports only query operation`,
                false,
                {
                  Allow: 'POST',
                },
              );
            }
          },
        };
      },
    });
  }

  // Create a local copy of `options`, based on global options, but maintaining
  // that appropriate plugins are in place.
  options = {
    ...options,
    plugins,
  };

  const partialResponse: Pick<HTTPGraphQLResponse, 'headers' | 'statusCode'> = {
    headers: new Map([['content-type', 'application/json']]),
    statusCode: undefined,
  };
  let body: string;

  try {
    const requestContext: GraphQLRequestContext<TContext> = {
      // While `logger` is guaranteed by internal Apollo Server usage of
      // this `processHTTPRequest` method, this method has been publicly
      // exported since perhaps as far back as Apollo Server 1.x.  Therefore,
      // for compatibility reasons, we'll default to `console`.
      // TODO(AS4): Probably when we refactor 'options' this special case will
      // go away.
      logger: options.logger || console,
      schema: options.schema,
      request: graphqlRequest,
      response: { http: partialResponse },
      // We clone the context because there are some assumptions that every operation
      // execution has a brand new context object; specifically, in order to implement
      // willResolveField we put a Symbol on the context that is specific to a particular
      // request pipeline execution. We could avoid this if we had a better way of
      // instrumenting execution.
      //
      // We don't want to do a deep clone here, because one of the main advantages of
      // using batched HTTP requests is to share context across operations for a
      // single request.
      // NOTE: THIS IS DUPLICATED IN ApolloServerBase.prototype.executeOperation.
      context: cloneObject(context),
      // TODO(AS4): fix ! as part of fixing GraphQLServerOptions
      cache: options.cache!,
      debug: options.debug,
      metrics: {},
      overallCachePolicy: newCachePolicy(),
    };
    const response = await processGraphQLRequest(options, requestContext);

    // This code is run on parse/validation errors and any other error that
    // doesn't reach GraphQL execution
    if (response.errors && typeof response.data === 'undefined') {
      // don't include options, since the errors have already been formatted
      return {
        statusCode: response.http?.statusCode || 400,
        headers: new Map([
          ['content-type', 'application/json'],
          ...response.http?.headers.entries(),
        ]),
        completeBody: prettyJSONStringify({
          // TODO(AS4): Understand why we don't call formatApolloErrors here.
          errors: response.errors,
          extensions: response.extensions,
        }),
        bodyChunks: null,
      };
    }

    body = prettyJSONStringify(serializeGraphQLResponse(response));
  } catch (error) {
    // TODO(AS4): NEXT: Process HttpQueryError instead of rethrowing
    if (error instanceof HttpQueryError) {
      throw error;
    }
    return throwHttpGraphQLError(500, [error as Error], options);
  }

  responseInit.headers!['Content-Length'] = Buffer.byteLength(
    body,
    'utf8',
  ).toString();

  return {
    graphqlResponse: body,
    responseInit,
  };
}

function serializeGraphQLResponse(
  response: GraphQLResponse,
): Pick<GraphQLResponse, 'errors' | 'data' | 'extensions'> {
  // See https://github.com/facebook/graphql/pull/384 for why
  // errors comes first.
  return {
    errors: response.errors,
    data: response.data,
    extensions: response.extensions,
  };
}

// The result of a curl does not appear well in the terminal, so we add an extra new line
function prettyJSONStringify(value: any) {
  return JSON.stringify(value) + '\n';
}

export function cloneObject<T extends Object>(object: T): T {
  return Object.assign(Object.create(Object.getPrototypeOf(object)), object);
}
