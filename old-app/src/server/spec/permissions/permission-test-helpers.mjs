/* eslint-disable no-loop-func */
/* eslint-disable key-spacing */

const ALL_ROLE_NAMES = [ 'masteradmin', 'support', 'superadmin', 'admin', 'member' ];

async function setupTest(primaryUserRole, secondaryUserRole, secondaryOrg) {
  let user2;
  let org2;

  let { user: user1, organization: org1 } = await this.factory.users.createWithOrganization({
    userData: {
      email: 'primary-user@example.com',
    },
    userRole: primaryUserRole,
  });

  if (secondaryUserRole) {
    if (secondaryOrg) {
      let { user: _user2, organization: _org2 } = await this.factory.users.createWithOrganization({
        userData: {
          email: 'secondary-user@example.com',
        },
        userRole: secondaryUserRole,
      });

      user2 = _user2;
      org2 = _org2;
    } else {
      let { user: _user2 } = await this.factory.users.create({
        data: {
          email: 'secondary-user@example.com',
        },
        organization: org1,
        userRole: secondaryUserRole,
      });

      user2 = _user2;
      org2 = undefined;
    }
  } else if (secondaryOrg) {
    org2 = (await this.factory.organizations.create()).organization;
  }

  const PermissionClass = this.PermissionClass;
  const permissions = new PermissionClass(this.app, user1);

  return {
    permissions,
    user1Role: primaryUserRole,
    user2Role: secondaryUserRole,
    user1,
    user2,
    org1,
    org2,
  };
}

function generateTests(descriptionTemplate, callback, shouldPassCallback) {
  const generateTest = (primaryUserRole, secondaryUserRole, hasSecondaryOrg, template) => {
    let shouldPass = shouldPassCallback({
      user1Role:  primaryUserRole,
      user2Role:  secondaryUserRole,
      otherOrg:   hasSecondaryOrg,
      orgType:    (hasSecondaryOrg) ? 'otherOrg' : 'sameOrg',
    });

    let description = template
      .replace(/#\{allow\}/g, (shouldPass) ? 'allow' : 'disallow')
      .replace(/#\{role\}/g, secondaryUserRole);

    this.it(
      description,
      async () => {
        const context = this.contextProvider();
        const args = await setupTest.call(context, primaryUserRole, secondaryUserRole, hasSecondaryOrg);
        await callback(Object.assign({}, args, { expectedResult: shouldPass }));
      },
    );
  };

  const generateDescribe = (primaryUserRole) => {
    this.describe(`as ${primaryUserRole} user`, () => {
      if (hasSecondaryUser) {
        for (let i = 0, il = ALL_ROLE_NAMES.length; i < il; i++) {
          let role = ALL_ROLE_NAMES[i];
          generateTest(primaryUserRole, role, false, descriptionTemplate);
        }

        if (hasSecondaryOrg) {
          for (let i = 0, il = ALL_ROLE_NAMES.length; i < il; i++) {
            let role = ALL_ROLE_NAMES[i];
            generateTest(primaryUserRole, role, true, descriptionTemplate);
          }
        }
      } else {
        generateTest(primaryUserRole, null, hasSecondaryOrg, descriptionTemplate);
      }
    });
  };

  const hasSecondaryUser  = (/#\{role\}/).test(descriptionTemplate);
  const hasSecondaryOrg   = (/different organization/).test(descriptionTemplate);

  for (let j = 0, jl = ALL_ROLE_NAMES.length; j < jl; j++) {
    let primaryUserRole = ALL_ROLE_NAMES[j];
    generateDescribe(primaryUserRole);
  }
}

export {
  ALL_ROLE_NAMES,
  setupTest,
  generateTests,
};
