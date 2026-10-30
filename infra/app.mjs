// Napkin Arcade serverless backbone: DynamoDB, S3, Cognito (custom passwordless auth), AppSync.
// The existing EC2 server (stack "napkin-arcade") keeps hosting the site, studio jobs and multiplayer.
import { App, Stack, Duration, RemovalPolicy, CfnOutput } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as appsync from "aws-cdk-lib/aws-appsync";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const app = new App();
const stack = new Stack(app, "NapkinArcadeServerless", { env: { account: process.env.CDK_DEFAULT_ACCOUNT || "992189742260", region: "us-east-1" }, description: "Napkin Arcade: DynamoDB, S3, Cognito custom auth, AppSync" });
const ctx = (k, d) => app.node.tryGetContext(k) ?? process.env[k] ?? d;
const SES_ROLE_ARN = ctx("SES_ROLE_ARN", "arn:aws:iam::975138397215:role/napkin-arcade-ses-sender");
const MAIL_FROM = ctx("MAIL_FROM", "Napkin Arcade <no-reply@revenuerush.in>");
const JUDGE_EMAIL = ctx("JUDGE_EMAIL", "ramu@mobil80.com");
const SERVER_ROLE = ctx("SERVER_ROLE", "napkin-arcade-InstanceRole-2LzB6HCHiHtp");

// ---- data ----
const table = new dynamodb.Table(stack, "Table", {
  tableName: "napkin-arcade",
  partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
  sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  timeToLiveAttribute: "ttl",
  pointInTimeRecovery: true,
  removalPolicy: RemovalPolicy.RETAIN,
});
for (const g of ["GSI1", "GSI2"]) table.addGlobalSecondaryIndex({ indexName: g, partitionKey: { name: `${g}PK`, type: dynamodb.AttributeType.STRING }, sortKey: { name: `${g}SK`, type: dynamodb.AttributeType.STRING } });

const bucket = new s3.Bucket(stack, "Games", {
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true,
  versioned: true, removalPolicy: RemovalPolicy.RETAIN,
});

// ---- Cognito: passwordless email code via custom auth triggers ----
const trigger = (name, handler, extra = {}) => new nodejs.NodejsFunction(stack, name, {
  entry: path.join(HERE, "..", "aws", "auth-triggers.mjs"), handler, runtime: lambda.Runtime.NODEJS_22_X,
  architecture: lambda.Architecture.ARM_64, memorySize: 256, timeout: Duration.seconds(10),
  bundling: { format: nodejs.OutputFormat.ESM, externalModules: ["@aws-sdk/*"], banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  ...extra,
});
const preSignUp = trigger("PreSignUp", "preSignUp");
const define = trigger("DefineAuth", "defineAuthChallenge");
const verify = trigger("VerifyAuth", "verifyAuthChallenge");
const create = trigger("CreateAuth", "createAuthChallenge", {
  environment: { SES_ROLE_ARN, SES_REGION: "us-east-1", MAIL_FROM, JUDGE_EMAIL, JUDGE_CODE_PARAM: "/napkin-arcade/judge-code" },
});
create.addToRolePolicy(new iam.PolicyStatement({ actions: ["sts:AssumeRole"], resources: [SES_ROLE_ARN] }));
create.addToRolePolicy(new iam.PolicyStatement({ actions: ["ssm:GetParameter"], resources: [`arn:aws:ssm:us-east-1:${stack.account}:parameter/napkin-arcade/judge-code`] }));

const pool = new cognito.UserPool(stack, "Users", {
  userPoolName: "napkin-arcade",
  selfSignUpEnabled: true,
  signInAliases: { email: true },
  standardAttributes: { email: { required: true, mutable: true }, fullname: { required: false, mutable: true } },
  accountRecovery: cognito.AccountRecovery.NONE,
  lambdaTriggers: { preSignUp, defineAuthChallenge: define, createAuthChallenge: create, verifyAuthChallengeResponse: verify },
  removalPolicy: RemovalPolicy.RETAIN,
});
const client = pool.addClient("Web", {
  userPoolClientName: "napkin-arcade-web",
  authFlows: { custom: true, userSrp: false, userPassword: false },
  generateSecret: false, preventUserExistenceErrors: true,
  idTokenValidity: Duration.hours(1), accessTokenValidity: Duration.hours(1), refreshTokenValidity: Duration.days(30),
});

// ---- AppSync: owner-only real-time studio events ----
const api = new appsync.GraphqlApi(stack, "Api", {
  name: "napkin-arcade",
  definition: appsync.Definition.fromFile(path.join(HERE, "schema.graphql")),
  authorizationConfig: {
    defaultAuthorization: { authorizationType: appsync.AuthorizationType.USER_POOL, userPoolConfig: { userPool: pool } },
    additionalAuthorizationModes: [{ authorizationType: appsync.AuthorizationType.IAM }],
  },
  xrayEnabled: false,
});
const none = api.addNoneDataSource("None");
const passthrough = `export function request(ctx) { return { payload: ctx.arguments }; }\nexport function response(ctx) { return ctx.result; }`;
none.createResolver("Publish", { typeName: "Mutation", fieldName: "publishStudioEvent", runtime: appsync.FunctionRuntime.JS_1_0_0, code: appsync.Code.fromInline(passthrough) });
none.createResolver("Ping", { typeName: "Query", fieldName: "ping", runtime: appsync.FunctionRuntime.JS_1_0_0, code: appsync.Code.fromInline(`export function request() { return { payload: "pong" }; }\nexport function response(ctx) { return ctx.result; }`) });
// Subscribers only receive events for games they own (owner = their Cognito user id).
none.createResolver("OnStudioEvent", {
  typeName: "Subscription", fieldName: "onStudioEvent", runtime: appsync.FunctionRuntime.JS_1_0_0,
  code: appsync.Code.fromInline(`import { util, extensions } from "@aws-appsync/utils";
export function request() { return { payload: null }; }
export function response(ctx) {
  extensions.setSubscriptionFilter(util.transform.toSubscriptionFilter({ owner: { eq: ctx.identity.sub } }));
  return null;
}`),
});

// ---- the EC2 server's existing role gets access ----
const serverRole = iam.Role.fromRoleName(stack, "ServerRole", SERVER_ROLE);
table.grantReadWriteData(serverRole);
bucket.grantReadWrite(serverRole);
api.grantMutation(serverRole, "publishStudioEvent");

new CfnOutput(stack, "TableName", { value: table.tableName });
new CfnOutput(stack, "BucketName", { value: bucket.bucketName });
new CfnOutput(stack, "UserPoolId", { value: pool.userPoolId });
new CfnOutput(stack, "UserPoolClientId", { value: client.userPoolClientId });
new CfnOutput(stack, "GraphqlUrl", { value: api.graphqlUrl });
new CfnOutput(stack, "CreateAuthRoleArn", { value: create.role.roleArn });
