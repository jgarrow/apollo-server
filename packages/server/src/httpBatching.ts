import type {
  HTTPGraphQLRequest,
  HTTPGraphQLResponse,
} from '@apollo/server-types';
import type GraphQLServerOptions from './graphqlOptions';
import { HeaderMap, runHttpQuery } from './runHttpQuery';

export async function runBatchHttpQuery<TContext>(
  batchRequest: Omit<HTTPGraphQLRequest, 'body'> & { body: any[] },
  context: TContext,
  serverOptions: GraphQLServerOptions<TContext>,
): Promise<HTTPGraphQLResponse> {
  // TODO(AS4): Handle empty list as an error

  const combinedResponse: HTTPGraphQLResponse = {
    headers: new HeaderMap(),
    bodyChunks: null,
    completeBody: '',
  };
  const responseBodies = await Promise.all(
    batchRequest.body.map(async (body: any) => {
      const singleRequest: HTTPGraphQLRequest = {
        ...batchRequest,
        body,
      };

      const response = await runHttpQuery(
        singleRequest,
        context,
        serverOptions,
      );

      if (response.completeBody === null) {
        // TODO(AS4): Implement incremental delivery or improve error handling.
        throw Error('Incremental delivery not implemented');
      }
      for (const [key, value] of response.headers) {
        // Override any similar header set in other responses.
        // TODO(AS4): this is what AS3 did but maybe this is silly
        combinedResponse.headers.set(key, value);
      }
      // If two responses both want to set the status code, one of them will win.
      // Note that the normal success case leaves statusCode empty.
      if (response.statusCode) {
        combinedResponse.statusCode = response.statusCode;
      }
      return response.completeBody;
    }),
  );
  combinedResponse.completeBody = `[${responseBodies.join(',')}]`;
  return combinedResponse;
}
