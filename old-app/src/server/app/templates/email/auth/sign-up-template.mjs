 

import { MasterEmailTemplate } from '../master-template.mjs';

export class AuthSignUpEmailTemplate extends MasterEmailTemplate {
  generateSubject() {
    return this.langTerm('email.auth.signUp.subject', 'Kikx Sign up Link');
  }

  async render() {
    let {
      // targetUser,
      // organization,
      magicLinkURL,
    } = this.getData();

    let content = this.langTerm('email.auth.signUp.content', 'Click the button below to sign up. It’s that easy!');

    return await super.render([
      this.section(
        this.header(this.langTerm('email.auth.signUp.header', 'Kikx Magic Link')),
      ),
      this.section(
        this.text(
          content,
          {
            'padding-bottom': this.sizePX(8),
          },
        ),
      ),
      this.section(
        this.button(
          this.langTerm('email.auth.signUp.button', 'Sign up for Kikx'),
          {
            href: magicLinkURL,
          },
        ),
      ),
    ]);
  }
}
