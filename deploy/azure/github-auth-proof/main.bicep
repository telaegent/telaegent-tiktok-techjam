targetScope = 'resourceGroup'

@description('Azure region for all proof resources.')
param location string = resourceGroup().location

@description('Name of the temporary proof VM.')
@minLength(1)
@maxLength(64)
param vmName string = 'vm-telaegent-gh-proof'

@description('Experimental VM size. This is not a production sizing decision.')
param vmSize string = 'Standard_B2s'

@description('Linux administrator account used only for this proof.')
@minLength(1)
@maxLength(32)
param adminUsername string = 'telaegent'

@description('Operator SSH public key. A private key must never be passed here.')
@secure()
param sshPublicKey string

@description('Single operator IPv4 CIDR allowed to reach SSH, for example 203.0.113.10/32.')
@minLength(9)
@maxLength(18)
param allowedSshSource string

@description('UTC expiry timestamp recorded as a cleanup tag.')
param expiresOn string

@description('Non-secret operator label recorded as a resource tag.')
param deployedBy string

@description('Pinned GitHub CLI version installed by cloud-init.')
param githubCliVersion string = '2.98.0'

@description('Official SHA-256 for the pinned Linux amd64 GitHub CLI archive.')
param githubCliSha256 string = '3b8ac6b30336802fc1a858d7c084e11cdf24ac1a761ca90b68022d7d729208de'

var commonTags = {
  project: 'telaegent'
  purpose: 'github-auth-proof'
  branch: 'khoa.dao'
  expiresOn: expiresOn
  deployedBy: deployedBy
  dataClassification: 'controlled-demo-only'
}

var addressPrefix = '10.42.0.0/16'
var subnetPrefix = '10.42.1.0/24'
var cloudInitTemplate = loadTextContent('cloud-init.yaml')
var cloudInitWithUser = replace(cloudInitTemplate, '__ADMIN_USERNAME__', adminUsername)
var cloudInitWithVersion = replace(cloudInitWithUser, '__GH_VERSION__', githubCliVersion)
var renderedCloudInit = replace(cloudInitWithVersion, '__GH_SHA256__', githubCliSha256)

resource nsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: '${vmName}-nsg'
  location: location
  tags: commonTags
  properties: {
    securityRules: [
      {
        name: 'AllowSshFromOperatorOnly'
        properties: {
          description: 'Temporary SSH access restricted to the explicitly supplied operator IPv4 address.'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '22'
          sourceAddressPrefix: allowedSshSource
          destinationAddressPrefix: '*'
          access: 'Allow'
          priority: 100
          direction: 'Inbound'
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${vmName}-vnet'
  location: location
  tags: commonTags
  properties: {
    addressSpace: {
      addressPrefixes: [
        addressPrefix
      ]
    }
  }
}

resource subnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: vnet
  name: 'runtime'
  properties: {
    addressPrefix: subnetPrefix
    networkSecurityGroup: {
      id: nsg.id
    }
    privateEndpointNetworkPolicies: 'Enabled'
    privateLinkServiceNetworkPolicies: 'Enabled'
  }
}

resource publicIp 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: '${vmName}-pip'
  location: location
  tags: commonTags
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
    idleTimeoutInMinutes: 4
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: '${vmName}-nic'
  location: location
  tags: commonTags
  properties: {
    enableAcceleratedNetworking: false
    enableIPForwarding: false
    ipConfigurations: [
      {
        name: 'primary'
        properties: {
          primary: true
          privateIPAllocationMethod: 'Dynamic'
          subnet: {
            id: subnet.id
          }
          publicIPAddress: {
            id: publicIp.id
          }
        }
      }
    ]
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: vmName
  location: location
  tags: commonTags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    hardwareProfile: {
      vmSize: vmSize
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: '0001-com-ubuntu-minimal-jammy'
        sku: 'minimal-22_04-lts-gen2'
        version: 'latest'
      }
      osDisk: {
        name: '${vmName}-os'
        createOption: 'FromImage'
        deleteOption: 'Delete'
        caching: 'ReadWrite'
        diskSizeGB: 32
        managedDisk: {
          storageAccountType: 'StandardSSD_LRS'
        }
      }
    }
    osProfile: {
      computerName: vmName
      adminUsername: adminUsername
      customData: base64(renderedCloudInit)
      allowExtensionOperations: true
      requireGuestProvisionSignal: true
      linuxConfiguration: {
        disablePasswordAuthentication: true
        provisionVMAgent: true
        patchSettings: {
          patchMode: 'ImageDefault'
          assessmentMode: 'ImageDefault'
        }
        ssh: {
          publicKeys: [
            {
              path: '/home/${adminUsername}/.ssh/authorized_keys'
              keyData: sshPublicKey
            }
          ]
        }
      }
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: nic.id
          properties: {
            primary: true
          }
        }
      ]
    }
    diagnosticsProfile: {
      bootDiagnostics: {
        enabled: true
      }
    }
    securityProfile: {
      securityType: 'TrustedLaunch'
      uefiSettings: {
        secureBootEnabled: true
        vTpmEnabled: true
      }
    }
  }
}

output resourceGroupName string = resourceGroup().name
output vmName string = vm.name
output location string = location
output publicIpAddress string = publicIp.properties.ipAddress
output adminUsername string = adminUsername
output managedIdentityPrincipalId string = vm.identity.principalId
output allowedSshSource string = allowedSshSource
output expiresOn string = expiresOn

