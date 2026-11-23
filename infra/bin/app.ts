#!/usr/bin/env node
import { App, Aspects, Tags } from 'aws-cdk-lib';
import { IncidentWorkflowStack } from '../lib/incident-workflow-stack';
import { NoWildcardActions } from '../lib/guardrails';

const app = new App();

const stack = new IncidentWorkflowStack(app, 'CareIncidentWorkflow', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'ap-southeast-2' },
  azs: Number(app.node.tryGetContext('azs') ?? 2),
  notifyEmail: app.node.tryGetContext('notifyEmail'),
  allowedOrigin: app.node.tryGetContext('allowedOrigin'),
});

Tags.of(stack).add('project', 'care-incident-workflow');
Aspects.of(app).add(new NoWildcardActions());
