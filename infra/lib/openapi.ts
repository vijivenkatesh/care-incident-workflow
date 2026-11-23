import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { Stack } from 'aws-cdk-lib';
import { IFunction } from 'aws-cdk-lib/aws-lambda';
import { IUserPool } from 'aws-cdk-lib/aws-cognito';

const METHODS = ['get', 'put', 'post', 'delete', 'patch'];

export interface ApiSpecOptions {
  specPath: string;
  handler: IFunction;
  userPool: IUserPool;
  allowedOrigin: string;
}

/**
 * Contract-first: loads the hand-written OpenAPI contract and adds only the
 * API Gateway vendor extensions (Lambda integration, Cognito authorizer,
 * request validation, CORS). The contract itself never mentions AWS.
 */
export function buildApiSpec(stack: Stack, opts: ApiSpecOptions): Record<string, any> {
  const spec = yaml.load(fs.readFileSync(opts.specPath, 'utf8')) as Record<string, any>;
  delete spec.servers; // documentation only; API Gateway sets the real host and stage
  const integrationUri =
    `arn:${stack.partition}:apigateway:${stack.region}:lambda:path/2015-03-31/functions/` +
    `${opts.handler.functionArn}/invocations`;
  const origin = `'${opts.allowedOrigin}'`;
  const corsHeaders = {
    'method.response.header.Access-Control-Allow-Origin': origin,
    'method.response.header.Access-Control-Allow-Headers': "'Authorization,Content-Type,X-Correlation-Id'",
    'method.response.header.Access-Control-Allow-Methods': "'GET,POST,PUT,OPTIONS'",
  };

  for (const pathItem of Object.values<Record<string, any>>(spec.paths)) {
    for (const method of METHODS.filter((m) => pathItem[m])) {
      pathItem[method]['x-amazon-apigateway-integration'] = {
        type: 'aws_proxy',
        httpMethod: 'POST',
        uri: integrationUri,
        passthroughBehavior: 'when_no_match',
      };
    }
    // CORS preflight answered by API Gateway itself, no Lambda or auth involved.
    pathItem.options = {
      security: [],
      responses: {
        '204': {
          description: 'CORS preflight',
          headers: Object.fromEntries(
            Object.keys(corsHeaders).map((h) => [h.replace('method.response.header.', ''), { schema: { type: 'string' } }]),
          ),
        },
      },
      'x-amazon-apigateway-integration': {
        type: 'mock',
        requestTemplates: { 'application/json': '{"statusCode": 204}' },
        responses: { default: { statusCode: '204', responseParameters: corsHeaders } },
      },
    };
  }

  spec.components.securitySchemes.CognitoJwt = {
    ...spec.components.securitySchemes.CognitoJwt,
    'x-amazon-apigateway-authtype': 'cognito_user_pools',
    'x-amazon-apigateway-authorizer': {
      type: 'cognito_user_pools',
      providerARNs: [opts.userPool.userPoolArn],
    },
  };

  spec['x-amazon-apigateway-request-validators'] = {
    all: { validateRequestBody: true, validateRequestParameters: true },
  };
  spec['x-amazon-apigateway-request-validator'] = 'all';

  // Errors raised by API Gateway itself (401 from the authorizer, 400 from validation)
  // still need CORS headers, or the browser hides them from the app.
  const gatewayCors = {
    'gatewayresponse.header.Access-Control-Allow-Origin': origin,
    'gatewayresponse.header.Access-Control-Allow-Headers': "'Authorization,Content-Type,X-Correlation-Id'",
  };
  spec['x-amazon-apigateway-gateway-responses'] = {
    DEFAULT_4XX: {
      responseParameters: gatewayCors,
      responseTemplates: {
        'application/json': '{"code":"$context.error.responseType","message":$context.error.messageString,"correlationId":"$context.requestId"}',
      },
    },
    DEFAULT_5XX: { responseParameters: gatewayCors },
  };
  return spec;
}
