/* eslint-disable no-magic-numbers */

import { MasterEmailTemplate } from '../master-template.mjs';

export class AuthSignInEmailTemplate extends MasterEmailTemplate {
  generateSubject() {
    return this.langTerm('email.auth.signIn.subject', 'Hero Magic Login Link');
  }

  async render() {
    let { magicLinkURL } = this.getData();

    return await super.render([
      this.section(
        this.header(this.langTerm('email.auth.signIn.header', 'Hero Magic Link')),
      ),
      this.section(
        this.text(
          this.langTerm('email.auth.signIn.content', 'Click the button below to login. It’s that easy!'),
          {
            'padding-bottom': this.sizePX(8),
          },
        ),
      ),
      this.section(
        this.button(
          this.langTerm('email.auth.signIn.button', 'Sign in to Hero'),
          {
            href: magicLinkURL,
          },
        ),
      ),
    ]);
  }
}
