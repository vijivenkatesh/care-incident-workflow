import * as fs from 'fs';
import * as path from 'path';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { buildApiSpec } from './openapi';

export interface IncidentWorkflowStackProps extends StackProps {
  /** Availability zones for the VPC and interface endpoints. 1 halves endpoint cost for demos. */
  azs?: number;
  /** Optional email subscribed to workflow notifications and operational alarms. */
  notifyEmail?: string;
  /** Override the browser origin allowed by CORS (e.g. http://localhost:5173 for local dev). */
  allowedOrigin?: string;
}

const ROOT = path.join(__dirname, '..', '..');

export class IncidentWorkflowStack extends Stack {
  constructor(scope: Construct, id: string, props: IncidentWorkflowStackProps = {}) {
    super(scope, id, props);

    // ---------------------------------------------------------------- network
    // Private isolated subnets only: no internet route at all. AWS services are
    // reached through VPC endpoints, so traffic never leaves the AWS network.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: props.azs ?? 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'private', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
      gatewayEndpoints: { DynamoDb: { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB } },
    });
    vpc.addFlowLog('FlowLogs', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(
        new logs.LogGroup(this, 'FlowLogGroup', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
      ),
      trafficType: ec2.FlowLogTrafficType.REJECT,
    });
    const endpoint = (name: string, service: ec2.InterfaceVpcEndpointAwsService) =>
      vpc.addInterfaceEndpoint(name, { service, privateDnsEnabled: true });
    endpoint('EventBridgeEndpoint', ec2.InterfaceVpcEndpointAwsService.EVENTBRIDGE);
    endpoint('SecretsManagerEndpoint', ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER);
    endpoint('SsmEndpoint', ec2.InterfaceVpcEndpointAwsService.SSM);
    const executeApiEndpoint = endpoint('ExecuteApiEndpoint', ec2.InterfaceVpcEndpointAwsService.APIGATEWAY);

    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc,
      description: 'Lambda functions: egress to VPC endpoints only',
      allowAllOutbound: false,
    });
    // HTTPS only. The subnets have no internet or NAT route, so 443 egress can only reach
    // the interface endpoints (VPC CIDR) and the DynamoDB gateway endpoint (AWS prefix list).
    lambdaSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS to VPC endpoints (no internet route exists)');

    // ------------------------------------------------------------------- data
    const incidentsTable = new dynamodb.TableV2(this, 'IncidentsTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      pointInTimeRecovery: true,
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY, // demo project; use RETAIN for real data
      globalSecondaryIndexes: [
        {
          indexName: 'byOwner',
          partitionKey: { name: 'createdBy', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.STRING },
        },
        {
          indexName: 'byStatus',
          partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.STRING },
        },
      ],
    });
    const auditTable = new dynamodb.TableV2(this, 'AuditTable', {
      partitionKey: { name: 'incidentId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      pointInTimeRecovery: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ------------------------------------------------- config and secrets
    const regulatorEndpoint = new ssm.StringParameter(this, 'RegulatorEndpoint', {
      parameterName: '/care-incidents/regulator-endpoint',
      stringValue: 'mock',
      description: 'Regulator submission URL, or "mock" to simulate submissions',
    });
    const regulatorSecret = new secretsmanager.Secret(this, 'RegulatorApiKey', {
      description: 'API key for the external regulator submission service',
      generateSecretString: { secretStringTemplate: '{}', generateStringKey: 'apiKey', excludePunctuation: true },
    });

    // ------------------------------------------------------------- messaging
    const bus = new events.EventBus(this, 'IncidentBus', { eventBusName: 'care-incidents' });
    bus.archive('IncidentArchive', {
      eventPattern: { source: ['care.incidents'] },
      retention: Duration.days(30),
      description: 'Replayable history of incident events',
    });

    const queueWithDlq = (name: string) => {
      const dlq = new sqs.Queue(this, `${name}Dlq`, {
        retentionPeriod: Duration.days(14),
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        enforceSSL: true,
      });
      const queue = new sqs.Queue(this, name, {
        visibilityTimeout: Duration.seconds(60),
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        enforceSSL: true,
        deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
      });
      return { queue, dlq };
    };
    const audit = queueWithDlq('AuditQueue');
    const regulator = queueWithDlq('RegulatorQueue');

    const notifications = new sns.Topic(this, 'NotificationsTopic', { displayName: 'Care incident notifications', enforceSSL: true });
    const opsAlerts = new sns.Topic(this, 'OpsAlertsTopic', { displayName: 'Care incident ops alarms', enforceSSL: true });
    if (props.notifyEmail) {
      notifications.addSubscription(new subs.EmailSubscription(props.notifyEmail));
      opsAlerts.addSubscription(new subs.EmailSubscription(props.notifyEmail));
    }

    const statusChanged = { source: ['care.incidents'], detailType: ['IncidentStatusChanged'] };
    new events.Rule(this, 'AuditRule', {
      eventBus: bus,
      eventPattern: statusChanged,
      targets: [new targets.SqsQueue(audit.queue)],
    });
    new events.Rule(this, 'RegulatorRule', {
      eventBus: bus,
      eventPattern: { ...statusChanged, detail: { status: ['REPORTED'] } },
      targets: [new targets.SqsQueue(regulator.queue)],
    });
    const notify = (id: string, detail: Record<string, unknown>, text: string) =>
      new events.Rule(this, id, {
        eventBus: bus,
        eventPattern: { ...statusChanged, detail },
        targets: [new targets.SnsTopic(notifications, { message: events.RuleTargetInput.fromText(text) })],
      });
    notify('UrgentIncidentRule', { status: ['SUBMITTED'], severity: ['HIGH', 'CRITICAL'] },
      `${events.EventField.fromPath('$.detail.severity')} incident submitted for review: ` +
      `"${events.EventField.fromPath('$.detail.title')}" (${events.EventField.fromPath('$.detail.incidentId')})`);
    notify('ReturnedIncidentRule', { status: ['RETURNED'] },
      `Incident "${events.EventField.fromPath('$.detail.title')}" was returned to ` +
      `${events.EventField.fromPath('$.detail.owner')}: ${events.EventField.fromPath('$.detail.comment')}`);

    // --------------------------------------------------------------- compute
    const code = lambda.Code.fromAsset(path.join(ROOT, 'services', 'src'), { exclude: ['**/__pycache__'] });
    const fn = (id: string, handler: string, environment: Record<string, string>, timeout = 10) =>
      new lambda.Function(this, id, {
        runtime: lambda.Runtime.PYTHON_3_12,
        architecture: lambda.Architecture.ARM_64,
        code,
        handler: `incidents.${handler}.lambda_handler`,
        timeout: Duration.seconds(timeout),
        memorySize: 256,
        tracing: lambda.Tracing.ACTIVE,
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        securityGroups: [lambdaSg],
        environment: { SERVICE_NAME: id, METRICS_NAMESPACE: 'CareIncidentWorkflow', ...environment },
        logGroup: new logs.LogGroup(this, `${id}Logs`, {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
      });

    // ------------------------------------------------- frontend hosting (CDN)
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const distribution = new cloudfront.Distribution(this, 'Site', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: '/index.html',
      })),
    });
    const siteOrigin = `https://${distribution.distributionDomainName}`;
    const allowedOrigin = props.allowedOrigin ?? siteOrigin;

    // ----------------------------------------------------------------- identity
    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: { minLength: 12, requireSymbols: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    for (const [groupName, description] of [
      ['staff', 'Front-line staff: raise and submit incidents'],
      ['supervisor', 'Review, approve or return incidents'],
      ['compliance', 'Report approved incidents to the regulator and close them'],
    ]) {
      new cognito.CfnUserPoolGroup(this, `Group-${groupName}`, { userPoolId: userPool.userPoolId, groupName, description });
    }
    const domain = userPool.addDomain('AuthDomain', {
      cognitoDomain: { domainPrefix: `care-incidents-${this.account}` },
    });
    const webClient = userPool.addClient('WebClient', {
      generateSecret: false, // public SPA client: Authorization Code + PKCE
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`${siteOrigin}/`, 'http://localhost:5173/'],
        logoutUrls: [`${siteOrigin}/`, 'http://localhost:5173/'],
      },
      idTokenValidity: Duration.minutes(60),
      accessTokenValidity: Duration.minutes(60),
      refreshTokenValidity: Duration.days(1),
      preventUserExistenceErrors: true,
    });

    // --------------------------------------------------- public REST API
    const apiFn = fn('IncidentsApi', 'api_handler', {
      TABLE_NAME: incidentsTable.tableName,
      EVENT_BUS_NAME: bus.eventBusName,
      ALLOWED_ORIGIN: allowedOrigin,
    });
    incidentsTable.grantReadWriteData(apiFn);
    bus.grantPutEventsTo(apiFn);

    const accessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const api = new apigw.SpecRestApi(this, 'IncidentsRestApi', {
      apiDefinition: apigw.ApiDefinition.fromInline(
        buildApiSpec(this, {
          specPath: path.join(ROOT, 'openapi', 'incidents-api.yaml'),
          handler: apiFn,
          userPool,
          allowedOrigin,
        }),
      ),
      endpointTypes: [apigw.EndpointType.REGIONAL],
      cloudWatchRole: true,
      cloudWatchRoleRemovalPolicy: RemovalPolicy.DESTROY,
      deployOptions: {
        stageName: 'v1',
        tracingEnabled: true,
        metricsEnabled: true,
        throttlingRateLimit: 50,
        throttlingBurstLimit: 100,
        accessLogDestination: new apigw.LogGroupLogDestination(accessLogs),
        accessLogFormat: apigw.AccessLogFormat.jsonWithStandardFields(),
      },
    });
    apiFn.addPermission('InvokeFromApiGateway', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: api.arnForExecuteApi(),
    });

    // ------------------------------------------- async consumers
    const auditFn = fn('AuditConsumer', 'audit_handler', { AUDIT_TABLE_NAME: auditTable.tableName });
    auditTable.grantWriteData(auditFn);
    auditFn.addEventSource(new SqsEventSource(audit.queue, { batchSize: 10, reportBatchItemFailures: true }));

    // ----------------------- private API for service-to-service calls (IAM)
    const internalFn = fn('InternalApi', 'internal_api_handler', { TABLE_NAME: incidentsTable.tableName });
    incidentsTable.grantReadData(internalFn);

    const regulatorFn = fn('RegulatorSubmitter', 'regulator_handler', {
      TABLE_NAME: incidentsTable.tableName,
      REGULATOR_ENDPOINT_PARAM: regulatorEndpoint.parameterName,
      REGULATOR_SECRET_ARN: regulatorSecret.secretArn,
    }, 30);

    const internalApi = new apigw.RestApi(this, 'InternalRestApi', {
      description: 'Private API: reachable only through the VPC endpoint, IAM (SigV4) auth',
      endpointConfiguration: { types: [apigw.EndpointType.PRIVATE], vpcEndpoints: [executeApiEndpoint] },
      cloudWatchRole: false,
      deployOptions: { stageName: 'internal', tracingEnabled: true, metricsEnabled: true },
      defaultMethodOptions: { authorizationType: apigw.AuthorizationType.IAM },
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [new iam.ArnPrincipal(regulatorFn.role!.roleArn)],
            actions: ['execute-api:Invoke'],
            resources: ['execute-api:/*'],
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: ['execute-api:Invoke'],
            resources: ['execute-api:/*'],
            conditions: { StringNotEquals: { 'aws:SourceVpce': executeApiEndpoint.vpcEndpointId } },
          }),
        ],
      }),
    });
    internalApi.root
      .addResource('internal').addResource('incidents').addResource('{incidentId}').addResource('summary')
      .addMethod('GET', new apigw.LambdaIntegration(internalFn));

    regulatorFn.addEnvironment('INTERNAL_API_URL', internalApi.url);
    regulatorEndpoint.grantRead(regulatorFn);
    regulatorSecret.grantRead(regulatorFn);
    regulatorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:UpdateItem'], // least privilege: it only ever sets regulatorReference
      resources: [incidentsTable.tableArn],
    }));
    regulatorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['execute-api:Invoke'],
      resources: [internalApi.arnForExecuteApi('GET', '/internal/incidents/*/summary', 'internal')],
    }));
    regulatorFn.addEventSource(new SqsEventSource(regulator.queue, { batchSize: 1, reportBatchItemFailures: true }));

    // ---------------------------------------------- frontend deployment
    const dist = path.join(ROOT, 'frontend', 'dist');
    if (fs.existsSync(dist)) {
      new s3deploy.BucketDeployment(this, 'DeploySite', {
        destinationBucket: siteBucket,
        distribution,
        sources: [
          s3deploy.Source.asset(dist),
          // Runtime config: the same build works in every environment.
          s3deploy.Source.jsonData('config.json', {
            mode: 'aws',
            apiUrl: api.url,
            authority: `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
            clientId: webClient.userPoolClientId,
            logoutUrl: `${domain.baseUrl()}/logout`,
          }),
        ],
      });
    }

    // ------------------------------------------------------- observability
    const alarmAction = new cwActions.SnsAction(opsAlerts);
    const alarm = (id: string, metric: cloudwatch.IMetric, threshold: number, description: string) => {
      const a = new cloudwatch.Alarm(this, id, {
        metric,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: description,
      });
      a.addAlarmAction(alarmAction);
      return a;
    };
    const functions = [apiFn, auditFn, internalFn, regulatorFn];
    functions.forEach((f) =>
      alarm(`${f.node.id}Errors`, f.metricErrors({ period: Duration.minutes(5) }), 1, `${f.node.id} Lambda errors`));
    alarm('AuditDlqNotEmpty', audit.dlq.metricApproximateNumberOfMessagesVisible(), 1, 'Audit events failed processing');
    alarm('RegulatorDlqNotEmpty', regulator.dlq.metricApproximateNumberOfMessagesVisible(), 1,
      'Regulator submissions failed: incidents not reported');
    alarm('Api5xx', api.metricServerError({ period: Duration.minutes(5) }), 5, 'API returning 5xx errors');

    const custom = (metricName: string) =>
      new cloudwatch.Metric({ namespace: 'CareIncidentWorkflow', metricName, statistic: 'Sum', period: Duration.minutes(5),
        dimensionsMap: { Service: metricName === 'RegulatorSubmissions' ? 'RegulatorSubmitter' : 'AuditConsumer' } });
    new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: 'care-incident-workflow',
      widgets: [
        [
          new cloudwatch.GraphWidget({ title: 'API requests and errors', left: [api.metricCount()], right: [api.metricClientError(), api.metricServerError()] }),
          new cloudwatch.GraphWidget({ title: 'API latency p90', left: [api.metricLatency({ statistic: 'p90' })] }),
          new cloudwatch.GraphWidget({ title: 'Lambda errors', left: functions.map((f) => f.metricErrors()) }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'Queue depth',
            left: [audit.queue, regulator.queue].map((q) => q.metricApproximateNumberOfMessagesVisible()),
            right: [audit.dlq, regulator.dlq].map((q) => q.metricApproximateNumberOfMessagesVisible()),
          }),
          new cloudwatch.GraphWidget({ title: 'Business metrics', left: [custom('RegulatorSubmissions'), custom('AuditRecordsFailed')] }),
          new cloudwatch.LogQueryWidget({
            title: 'Recent errors (structured logs)',
            logGroupNames: functions.map((f) => f.logGroup.logGroupName),
            queryLines: [
              'fields timestamp, service, message, correlationId, error',
              'filter level = "ERROR"',
              'sort timestamp desc',
              'limit 20',
            ],
          }),
        ],
      ],
    });

    new CfnOutput(this, 'ApiUrl', { value: api.url });
    new CfnOutput(this, 'SiteUrl', { value: siteOrigin });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'WebClientId', { value: webClient.userPoolClientId });
    new CfnOutput(this, 'InternalApiUrl', { value: internalApi.url, description: 'Private: resolvable only inside the VPC' });
  }
}
