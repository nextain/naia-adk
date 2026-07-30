import fs from "node:fs";
import path from "node:path";
import { digestCanonical } from "./validate-bundle.mjs";
import { packageRoot } from "./price-snapshot.mjs";

export const routeConfigurationsPath=path.join(packageRoot,"baselines","pre-recovery.route-configurations.json");

export function loadRouteConfiguration(route,configPath=routeConfigurationsPath){
  const configurations=JSON.parse(fs.readFileSync(configPath,"utf8"));
  const configuration=configurations[route.id];
  if(!configuration||configuration.model!==route.exact_model_id||configuration.provider!==route.provider||digestCanonical(configuration)!==route.configuration_digest)throw Object.assign(new Error(`route configuration is not digest-bound: ${route.id}`),{code:"route_configuration_tampered"});
  return structuredClone(configuration);
}
