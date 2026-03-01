/* eslint-disable no-magic-numbers */

import { OrgBaseTemplate } from './org-template-base.mjs';

export class OrgUserRolesUpdatedEmailTemplate extends OrgBaseTemplate {
  generateSubject() {
    let {
      organization,
    } = this.getData();

    return this.langTerm(
      'email.org.userRolesUpdated.subject',
      'Your user permissions have been updated',
      { params: { name: organization.name } },
    );
  }

  lineContent(header, content) {
    let finalContent;
    let headerStyle = this.objectToStyleCSS({
      'display':        'inline-block',
      'font-weight':    '600',
      'color':          OrgBaseTemplate.BLACK_TEXT_COLOR,
      'font-size':      14,
      'line-height':    (content) ? 20 : 36,
      'padding-bottom': (content) ? 8 : 0,
    });

    if (content) {
      let contentStyle = this.objectToStyleCSS({
        'display':        'inline-block',
        'color':          OrgBaseTemplate.GREY_TEXT_COLOR,
        'font-size':      12,
        'line-height':    22,
        'padding-top':    '0px',
        'padding-bottom': '0px',
      });

      finalContent = `<span style="${headerStyle}">${header}</span><br><span style="${contentStyle}">${content}</span>`;
    } else {
      finalContent = `<span style="${headerStyle}">${header}</span>`;
    }

    return this.text(
      finalContent,
      {
        'align':          'left',
        'padding-bottom': this.sizePX(18),
        'padding-left':   this.sizePX(8),
        'vertical-align': 'middle',
      },
    );
  }

  async render() {
    let {
      magicLinkURL,
      organization,
      addedRoles,
      removedRoles,
    } = this.getData();

    let addedRoleNames    = this.getRoleNamesFromRoles(addedRoles);
    let removedRoleNames  = this.getRoleNamesFromRoles(removedRoles);

    return await super.render([
      this.section(
        this.header(
          this.langTerm(
            'email.org.userRolesUpdated.header',
            'Your user permissions have been updated for the {{name}} Kikx organization:',
            { params: { name: this.secondaryColor(organization.name) } },
          ),
        ),
      ),
      this.table(
        { 'css-class': 'kikx-group' },
        {
          columns: [
            {
              attributes: {
                // 36 + 16 right-side padding
                'width': this.sizePX(52),
              },
              children: [
                this.iconWithBox('shield-plus'),
              ],
            },
            {
              children: [
                this.lineContent(
                  this.langTerm(
                    'email.org.userRolesUpdated.addedRolesHeader',
                    'The following permissions have been granted:',
                  ),
                  `<ul style="margin:0;">${addedRoleNames.map((roleName) => `<li>${roleName}</li>`).join('')}</ul>`,
                ),
              ],
            },
          ],
        },
        {
          columns: [
            {
              attributes: {
                // 36 + 16 right-side padding
                'width': this.sizePX(52),
              },
              children: [
                this.iconWithBox('shield-minus'),
              ],
            },
            {
              children: [
                this.lineContent(
                  this.langTerm(
                    'email.org.userRolesUpdated.removedRolesHeader',
                    'The following permissions have been revoked:',
                  ),
                  `<ul style="margin:0;">${removedRoleNames.map((roleName) => `<li>${roleName}</li>`).join('')}</ul>`,
                ),
              ],
            },
          ],
        },
      ),
      this.section(
        this.text(
          this.langTerm('email.org.userRolesUpdated.content', 'Click the button below to view the Kikx web app.'),
          {
            'padding-top':    this.sizePX(16),
            'padding-bottom': this.sizePX(8),
          },
        ),
      ),
      this.section(
        this.button(
          this.langTerm('email.org.userRolesUpdated.button', 'Go to the app'),
          {
            href: magicLinkURL,
          },
        ),
      ),
    ]);
  }
}
