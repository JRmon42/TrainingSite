// Certification Trainer — App Service (Linux container) with Entra Easy Auth,
// Azure Files persistence, ACR (managed-identity pull), and App Insights.
//
// The container image is built into the referenced ACR (via `az acr build`)
// BEFORE this template is deployed, so the web app starts cleanly on first boot.

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Name of the EXISTING Azure Container Registry that holds the image.')
param acrName string

@description('Container image (repository:tag) within the ACR.')
param imageName string = 'certification-trainer:latest'

@description('Prefix used to build unique resource names.')
param namePrefix string = 'ct'

@description('App Service plan SKU.')
param appServicePlanSku string = 'B1'

@description('Common tags applied to all resources.')
param tags object = {
  application: 'certification-trainer'
  managedBy: 'bicep'
}

var suffix = uniqueString(resourceGroup().id)
var webAppName = '${namePrefix}-app-${suffix}'
var planName = '${namePrefix}-plan-${suffix}'
var logName = '${namePrefix}-logs-${suffix}'
var aiName = '${namePrefix}-ai-${suffix}'
var acrPullRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
}

resource logWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logName
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: aiName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logWorkspace.id
  }
}

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: planName
  location: location
  tags: tags
  kind: 'linux'
  sku: {
    name: appServicePlanSku
    tier: 'Basic'
  }
  properties: {
    reserved: true
  }
}

resource webApp 'Microsoft.Web/sites@2023-12-01' = {
  name: webAppName
  location: location
  tags: tags
  kind: 'app,linux,container'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'DOCKER|${acr.properties.loginServer}/${imageName}'
      acrUseManagedIdentityCreds: true
      alwaysOn: true
      ftpsState: 'Disabled'
      healthCheckPath: '/health'
      minTlsVersion: '1.2'
      appSettings: [
        { name: 'WEBSITES_PORT', value: '8080' }
        { name: 'PORT', value: '8080' }
        { name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE', value: 'true' }
        { name: 'DATA_DIR', value: '/home/data' }
        { name: 'DOCKER_REGISTRY_SERVER_URL', value: 'https://${acr.properties.loginServer}' }
        { name: 'DOCKER_ENABLE_CI', value: 'true' }
        { name: 'PYTHON', value: '/opt/venv/bin/python3' }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
        { name: 'WEBSITE_HEALTHCHECK_MAXPINGFAILURES', value: '5' }
      ]
    }
  }
}

// Let the web app's managed identity pull from ACR.
resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, webApp.id, acrPullRoleId)
  scope: acr
  properties: {
    principalId: webApp.identity.principalId
    roleDefinitionId: acrPullRoleId
    principalType: 'ServicePrincipal'
  }
}

output webAppName string = webApp.name
output defaultHostName string = webApp.properties.defaultHostName
output principalId string = webApp.identity.principalId
output acrLoginServer string = acr.properties.loginServer
