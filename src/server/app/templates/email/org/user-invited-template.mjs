import { OrgBaseTemplate } from './org-template-base.mjs';

export class OrgUserInvitationEmailTemplate extends OrgBaseTemplate {
  generateSubject() {
    let {
      organization,
    } = this.getData();

    return this.langTerm(
      'email.org.userInvitation.subject',
      'Invitation to join the {{name}} organization at Kikx',
      {
        params: {
          name: organization.name,
        },
      },
    );
  }

  async render() {
    let {
      initiatingUser,
      organization,
      magicLinkURL,
      roles,
    } = this.getData();

    let magicLinkCaption  = this.langTerm('email.org.userInvitation.loginLinkCaption', 'Click here to accept invitation');
    let roleNames         = this.getRoleNamesFromRoles(roles);
    let roleName          = roleNames[0] || 'Member';

    return await super.render([
      this.text(
        // TODO: @I18N
        `<b>${initiatingUser.email}</b> has invited you to join the <b>${organization.name}</b> Kikx Organization as ${this.formatSingularRoleName(roleName)}. To accept this invite and login, click <a href="${magicLinkURL}">${magicLinkCaption}</a>.<br><i>Note: This will expire in 24 hours.</i>`,
      ),
    ]);
  }
}
