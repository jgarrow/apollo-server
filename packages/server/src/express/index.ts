import type express from 'express';
import {
  ApolloServerBase,
  runHttpQuery,
  convertNodeHttpToRequest,
  isHttpQueryError,
} from '..';
import accepts from 'accepts';
import asyncHandler from 'express-async-handler';
import type { BaseContext } from '@apollo/server-types';
import { debugFromNodeEnv, throwHttpGraphQLError } from '../runHttpQuery';
import type { HTTPGraphQLRequest } from '@apollo/server-types';

export interface ExpressContext {
  req: express.Request;
  res: express.Response;
}

// Renaming this temporarily. We'll remove the concept of subclassing ApolloServer
// soon.
export class ApolloServerExpress<
  TContext extends BaseContext = BaseContext,
> extends ApolloServerBase<TContext> {
  // TODO: While `express` is not Promise-aware, this should become `async` in
  // a major release in order to align the API with other integrations (e.g.
  // Hapi) which must be `async`.
  public getMiddleware(
    contextFunction: (expressContext: ExpressContext) => Promise<TContext>,
  ): express.RequestHandler {
    this.assertStarted('getMiddleware');

    const landingPage = this.getLandingPage();

    return asyncHandler(async (req, res) => {
      // TODO(AS4): move landing page logic into core
      if (landingPage && prefersHtml(req)) {
        res.setHeader('Content-Type', 'text/html');
        res.write(landingPage.html);
        res.end();
        return;
      }

      if (!req.body) {
        // The json body-parser *always* sets req.body to {} if it's unset (even
        // if the Content-Type doesn't match), so if it isn't set, you probably
        // forgot to set up body-parser. (Note that this may change in the future
        // body-parser@2.)
        res.status(500);
        res.send(
          '`req.body` is not set; this probably means you forgot to set up the ' +
            '`body-parser` middleware before the Apollo Server middleware.',
        );
        return;
      }

      function handleError(error: any) {
        if (!isHttpQueryError(error)) {
          throw error;
        }

        if (error.headers) {
          for (const [name, value] of Object.entries(error.headers)) {
            res.setHeader(name, value);
          }
        }

        res.statusCode = error.statusCode;
        res.send(error.message);
        return;
      }

      // TODO(AS4): Invoke the context function via some ApolloServer method
      // that does error handling in a consistent and plugin-visible way. For
      // now we will fall back to some old code that throws an HTTP-GraphQL
      // error and we will catch and handle it, blah.
      let context: TContext;
      try {
        context = await contextFunction({ req, res });
      } catch (e: any) {
        try {
          // XXX `any` isn't ideal, but this is the easiest thing for now, without
          // introducing a strong `instanceof GraphQLError` requirement.
          e.message = `Context creation failed: ${e.message}`;
          // For errors that are not internal, such as authentication, we
          // should provide a 400 response
          const statusCode =
            e.extensions &&
            e.extensions.code &&
            e.extensions.code !== 'INTERNAL_SERVER_ERROR'
              ? 400
              : 500;
          // XXX when we get rid of this function, make sure this line still does formatApolloErrors
          throwHttpGraphQLError(statusCode, [e], {
            debug:
              this.requestOptions.debug ??
              debugFromNodeEnv(this.requestOptions.nodeEnv),
            formatError: this.requestOptions.formatError,
          });
        } catch (error: any) {
          handleError(error);
        }
        return;
      }

      const headers = new Map<string, string>();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined) {
          // Node/Express headers can be an array or a single value. We join
          // multi-valued headers with `, ` just like the Fetch API's `Headers`
          // does. We assume that keys are already lower-cased (as per the Node
          // docs on IncomingMessage.headers) and so we don't bother to lower-case
          // them or combine across multiple keys that would lower-case to the
          // same value.
          headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
      }

      // TODO(AS4): Make batching optional and off by default; perhaps move it
      // to a separate middleware.
      const requestBodies = Array.isArray(req.body) ? req.body : [req.body];
      // TODO(AS4): Handle empty list as an error
      const responseBodies = await Promise.all(
        requestBodies.map(async (body) => {
          const request: HTTPGraphQLRequest = {
            method: req.method.toUpperCase(),
            headers,
            pathname: req.path,
            searchParams: req.query,
            body,
          };

          let response;
          try {
            response = await runHttpQuery(
              request,
              context,
              // TODO(AS4): error handling
              await this.graphQLServerOptions(),
            );
          } catch (error: any) {
            handleError(error);
            return;
          }

          if (response.completeBody === null) {
            // TODO(AS4): Implement incremental delivery or improve error handling.
            throw Error('Incremental delivery not implemented');
          }
          for (const [key, value] of response.headers) {
            // Override any similar header set in other responses.
            // TODO(AS4): this is what AS3 did but maybe this is silly
            res.setHeader(key, value);
          }
          // If two responses both want to set the status code, one of them will win.
          // Note that the normal success case leaves statusCode empty.
          if (response.statusCode) {
            res.statusCode = response.statusCode;
          }
          return response.completeBody;
        }),
      );

      if (!res.statusCode) {
        res.statusCode = 200;
      }
      res.send(
        Array.isArray(req.body)
          ? `[${responseBodies.join(',')}]`
          : responseBodies[0],
      );
    });
  }
}

function prefersHtml(req: express.Request): boolean {
  if (req.method !== 'GET') {
    return false;
  }
  const accept = accepts(req);
  const types = accept.types() as string[];
  return (
    types.find((x: string) => x === 'text/html' || x === 'application/json') ===
    'text/html'
  );
}
