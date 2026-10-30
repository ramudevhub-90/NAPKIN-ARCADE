// One-off: copy the old single leaderboard (GAME#<id> / SCORE#…) onto the new boards
// (this week / this month / all time). Safe to re-run: each copy keeps the original timestamp.
//   TABLE=napkin-arcade node aws/migrate-leaderboards.mjs
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { addScore } from "./lib/store.mjs";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
let key, n = 0;
do {
  const out = await db.send(new ScanCommand({ TableName: process.env.TABLE, FilterExpression: "begins_with(sk, :s)", ExpressionAttributeValues: { ":s": "SCORE#" }, ExclusiveStartKey: key }));
  for (const it of out.Items || []) {
    const { name, score, progress, won, time } = it;
    await addScore(it.pk.slice(5), { name, score, progress, won, time }, new Date(+it.sk.split("#").pop()));
    n++;
  }
  key = out.LastEvaluatedKey;
} while (key);
console.log(`copied ${n} scores`);
