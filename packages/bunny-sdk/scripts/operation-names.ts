/**
 * Operation names, keyed by "METHOD /path".
 *
 * Bunny's operationIds are `Controller_Action` pairs whose derived names
 * mislead: `PullZonePublic_Index` (GET /pullzone/{id}) becomes
 * `listPullZonePublic` although it returns one zone. `convert.ts` rewrites
 * the operationId of every route listed here before conversion; routes not
 * listed keep their derived name.
 */
export const CORE_OPERATION_NAMES: Readonly<Record<string, string>> = {
  // Storage zones
  "GET /storagezone": "listStorageZones",
  "POST /storagezone": "createStorageZone",
  "POST /storagezone/checkavailability": "checkStorageZoneAvailability",
  "GET /storagezone/regions": "listStorageZoneRegions",
  "POST /storagezone/resetReadOnlyPassword": "resetStorageZoneReadOnlyPassword",
  "GET /storagezone/{id}": "getStorageZone",
  "POST /storagezone/{id}": "updateStorageZone",
  "DELETE /storagezone/{id}": "deleteStorageZone",
  "POST /storagezone/{id}/resetPassword": "resetStorageZonePassword",
  "GET /storagezone/{id}/statistics": "getStorageZoneStatistics",
  "GET /storagezone/{id}/statistics/egress": "getStorageZoneEgressStatistics",

  // Pull zones
  "GET /pullzone": "listPullZones",
  "POST /pullzone": "createPullZone",
  "POST /pullzone/checkavailability": "checkPullZoneAvailability",
  "GET /pullzone/count": "countPullZones",
  "GET /pullzone/{id}": "getPullZone",
  "POST /pullzone/{id}": "updatePullZone",
  "DELETE /pullzone/{id}": "deletePullZone",
  "POST /pullzone/{id}/purgeCache": "purgePullZoneCache",
  "POST /pullzone/{id}/resetSecurityKey": "resetPullZoneSecurityKey",
  "POST /pullzone/{id}/addAllowedReferrer": "addPullZoneAllowedReferrer",
  "POST /pullzone/{id}/removeAllowedReferrer": "removePullZoneAllowedReferrer",
  "POST /pullzone/{id}/addBlockedReferrer": "addPullZoneBlockedReferrer",
  "POST /pullzone/{id}/removeBlockedReferrer": "removePullZoneBlockedReferrer",
  "POST /pullzone/{id}/addBlockedIp": "addPullZoneBlockedIp",
  "POST /pullzone/{id}/removeBlockedIp": "removePullZoneBlockedIp",

  // Pull zone hostnames and certificates
  "POST /pullzone/{id}/addHostname": "addPullZoneHostname",
  "DELETE /pullzone/{id}/removeHostname": "removePullZoneHostname",
  "POST /pullzone/{id}/setForceSSL": "setPullZoneForceSSL",
  "POST /pullzone/{id}/addCertificate": "addPullZoneCertificate",
  "DELETE /pullzone/{id}/removeCertificate": "removePullZoneCertificate",
  "POST /pullzone/{id}/updatePrivateKeyType": "updatePullZonePrivateKeyType",
  "GET /pullzone/loadFreeCertificate": "loadFreeCertificate",
  "POST /pullzone/requestExternalDnsCertificate": "requestExternalDnsCertificate",
  "POST /pullzone/requestExternalHttpCertificate": "requestExternalHttpCertificate",
  "POST /pullzone/completeExternalDnsCertificate": "completeExternalDnsCertificate",
  "POST /pullzone/completeExternalHttpCertificate": "completeExternalHttpCertificate",

  // Edge rules
  "POST /pullzone/{pullZoneId}/edgerules/addOrUpdate": "upsertEdgeRule",
  "DELETE /pullzone/{pullZoneId}/edgerules/{edgeRuleId}": "deleteEdgeRule",
  "POST /pullzone/{pullZoneId}/edgerules/{edgeRuleId}/setEdgeRuleEnabled":
    "setEdgeRuleEnabled",

  // URL purge
  "POST /purge": "purgeUrl",

  // DNS
  "GET /dnszone": "listDnsZones",
  "POST /dnszone": "createDnsZone",
  "POST /dnszone/checkavailability": "checkDnsZoneAvailability",
  "GET /dnszone/{id}": "getDnsZone",
  "POST /dnszone/{id}": "updateDnsZone",
  "DELETE /dnszone/{id}": "deleteDnsZone",
  "POST /dnszone/{id}/dnssec": "enableDnsZoneDnssec",
  "DELETE /dnszone/{id}/dnssec": "disableDnsZoneDnssec",
  "GET /dnszone/{id}/export": "exportDnsZone",
  "POST /dnszone/{zoneId}/import": "importDnsZone",
  "POST /dnszone/{zoneId}/certificate/issue": "issueDnsZoneWildcardCertificate",
  "GET /dnszone/{zoneId}/records": "listDnsRecords",
  "PUT /dnszone/{zoneId}/records": "createDnsRecord",
  "POST /dnszone/{zoneId}/records/{id}": "updateDnsRecord",
  "DELETE /dnszone/{zoneId}/records/{id}": "deleteDnsRecord",
};

export const COMPUTE_OPERATION_NAMES: Readonly<Record<string, string>> = {
  "GET /compute/script": "listEdgeScripts",
  "POST /compute/script": "createEdgeScript",
  "GET /compute/script/{id}": "getEdgeScript",
  "POST /compute/script/{id}": "updateEdgeScript",
  "DELETE /compute/script/{id}": "deleteEdgeScript",
  "GET /compute/script/{id}/code": "getEdgeScriptCode",
  "POST /compute/script/{id}/code": "setEdgeScriptCode",
  "POST /compute/script/{id}/deploymentKey/rotate": "rotateEdgeScriptDeploymentKey",
  "POST /compute/script/{id}/publish": "publishEdgeScript",
  "POST /compute/script/{id}/publish/{uuid}": "publishEdgeScriptRelease",
  "GET /compute/script/{id}/releases": "listEdgeScriptReleases",
  "GET /compute/script/{id}/releases/active": "getActiveEdgeScriptRelease",
  "GET /compute/script/{id}/statistics": "getEdgeScriptStatistics",
  "GET /compute/script/{id}/secrets": "listEdgeScriptSecrets",
  "POST /compute/script/{id}/secrets": "addEdgeScriptSecret",
  "PUT /compute/script/{id}/secrets": "upsertEdgeScriptSecret",
  "POST /compute/script/{id}/secrets/{secretId}": "updateEdgeScriptSecret",
  "DELETE /compute/script/{id}/secrets/{secretId}": "deleteEdgeScriptSecret",
  "POST /compute/script/{id}/variables/add": "addEdgeScriptVariable",
  "PUT /compute/script/{id}/variables": "upsertEdgeScriptVariable",
  "GET /compute/script/{id}/variables/{variableId}": "getEdgeScriptVariable",
  "POST /compute/script/{id}/variables/{variableId}": "updateEdgeScriptVariable",
  "DELETE /compute/script/{id}/variables/{variableId}": "deleteEdgeScriptVariable",
};

/**
 * Bunny Database. Only `/v2/databases*` and `/v1/config*` are kept (see
 * `DATABASE_ROUTES` in convert.ts): the official CLI uses nothing else, and
 * the v1 group/database routes are the older API.
 */
export const DATABASE_OPERATION_NAMES: Readonly<Record<string, string>> = {
  "GET /v1/config": "getDatabaseConfig",
  "GET /v1/config/limits": "getDatabaseLimits",
  "GET /v1/config/optimal": "getOptimalDatabaseRegions",
  "GET /v1/config/optimal_single": "getOptimalDatabaseRegion",
  "GET /v2/databases": "listDatabases",
  "POST /v2/databases": "createDatabase",
  "GET /v2/databases/active_usage": "getDatabasesActiveUsage",
  "GET /v2/databases/{db_id}": "getDatabase",
  "PATCH /v2/databases/{db_id}": "updateDatabase",
  "DELETE /v2/databases/{db_id}": "deleteDatabase",
  "GET /v2/databases/{db_id}/usage": "getDatabaseUsage",
  "GET /v2/databases/{db_id}/statistics": "getDatabaseStatistics",
  "PUT /v2/databases/{db_id}/auth/generate": "generateDatabaseToken",
  "POST /v2/databases/{db_id}/auth/revoke": "revokeDatabaseTokens",
};
