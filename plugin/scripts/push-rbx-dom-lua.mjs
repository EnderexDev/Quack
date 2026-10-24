import { execSync } from "node:child_process";

const SOURCE_FOLDER = "plugin/Vendor";
const DESTINATION = "ReplicatedFirst.QuackPlugin.Vendor";

execSync(
  `quack push -s ${SOURCE_FOLDER} -d ${DESTINATION} --rojo --destructive --no-warn`,
  { stdio: "inherit" },
);
