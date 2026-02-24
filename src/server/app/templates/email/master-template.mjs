/* eslint-disable no-magic-numbers */

import Nife           from 'nife';
import mjmlToHTML     from 'mjml';
import { HTTPUtils }  from 'mythix';
import Utils          from '../../utils/index.mjs';

// This defines the "master" template for all emails.
// All email templates call this master template method,
// providing their own personal contents, and this
// master template will provide the rest of the template
// for all emails.

const SCALE_FACTOR            = 1.0;
const PRIMARY_ICON_IMAGE      = 'https://example.com/my-icon.png';
const PRIMARY_ICON_IMAGE_SIZE = `${50.0 * SCALE_FACTOR}px`;
const PRIMARY_COLOR           = '#4F46E5';
const SECONDARY_COLOR         = '#3730A3';
const BLACK_TEXT_COLOR        = '#111827';
const WHITE_TEXT_COLOR        = '#FFFFFF';
const GREY_TEXT_COLOR         = '#6B7280';
const GREY_COLOR              = '#C4C8CE';
const CONTAINER_BACKGROUND    = '#EFF6FF';
const CONTAINER_BORDER        = '#BFDBFE';
const FONT_FAMILY             = 'sans-serif';
const BORDER_RADIUS           = 8;
const ICON_FONT               = 'Font Awesome 6 Free';

export class MasterEmailTemplate {
  static SCALE_FACTOR = SCALE_FACTOR;

  static PRIMARY_COLOR = PRIMARY_COLOR;

  static SECONDARY_COLOR = SECONDARY_COLOR;

  static BLACK_TEXT_COLOR = BLACK_TEXT_COLOR;

  static WHITE_TEXT_COLOR = WHITE_TEXT_COLOR;

  static GREY_TEXT_COLOR = GREY_TEXT_COLOR;

  static CONTAINER_BACKGROUND = CONTAINER_BACKGROUND;

  static CONTAINER_BORDER = CONTAINER_BORDER;

  static BORDER_RADIUS = BORDER_RADIUS;

  constructor(application, data) {
    Object.defineProperties(this, {
      '_application': {
        writable:     true,
        enumberable:  false,
        configurable: true,
        value:        application,
      },
      '_data': {
        writable:     true,
        enumberable:  false,
        configurable: true,
        value:        data || {},
      },
    });
  }

  getApplication() {
    return this._application;
  }

  getConnection() {
    let app = this.getApplication();
    return app.getConnection();
  }

  getModel(modelName) {
    let connection = this.getConnection();
    return connection.getModel(modelName);
  }

  getModels() {
    let connection = this.getConnection();
    return connection.getModels();
  }

  getData() {
    return this._data;
  }

  getUserFullName(user) {
    let userFullName = [
      user.firstName,
      user.lastName,
    ].filter(Boolean).join(' ');

    return userFullName;
  }

  getInitiatingUserName() {
    let { initiatingUser } = this.getData();
    return this.getUserFullName(initiatingUser);
  }

  getTargetUserName() {
    let { targetUser } = this.getData();
    return this.getUserFullName(targetUser);
  }

  langTerm(...args) {
    return Utils.langTerm(...args);
  }

  getRootAppURL(path, queryParams) {
    let app         = this.getApplication();
    let appRootURL  = app.getConfigValue('application.{environment}.appRootURL', 'https://Hero.com/');
    let queryStr    = '';

    appRootURL = appRootURL.replace(/\/+$/, '');

    if (Nife.isNotEmpty(queryParams))
      queryStr = HTTPUtils.dataToQueryString(queryParams);

    return `${appRootURL}/${path}${queryStr}`;
  }

  getHelpURL() {
    let app         = this.getApplication();
    let getHelpURL  = app.getConfigValue('application.{environment}.getHelpURL', 'https://hero.com');

    return getHelpURL;
  }

  primaryColor(text) {
    return `<span style="color:${PRIMARY_COLOR}">${text}</span>`;
  }

  secondaryColor(text) {
    return `<span style="color:${SECONDARY_COLOR}">${text}</span>`;
  }

  sizePX(number) {
    return `${number * SCALE_FACTOR}px`;
  }

  objectToStyleCSS(obj) {
    let keys  = Object.keys(obj);
    let parts = [];

    for (let i = 0, il = keys.length; i < il; i++) {
      let key   = keys[i];
      let value = obj[key];
      if (value == null)
        continue;

      if (Nife.instanceOf(value, 'number'))
        value = this.sizePX(value);

      parts.push(`${key}:${value};`);
    }

    return parts.join('');
  }

  divider(props) {
    return {
      tagName:    'mj-divider',
      attributes: {
        'border-color':   GREY_COLOR,
        'border-style':   'solid',
        'border-width':   '2px',
        'padding-left':   '0px',
        'padding-right':  '0px',
        ...(props || {}),
      },
    };
  }

  section(...children) {
    return this.sectionWithProps(null, ...children);
  }

  sectionWithProps(props, ...children) {
    return {
      tagName:    'mj-section',
      attributes: {},
      children:   [
        {
          tagName:    'mj-column',
          attributes: {
            ...(props || {}),
          },
          children:   children,
        },
      ],
    };
  }

  convertMJMLObjectToHTML(_obj) {
    let elements  = Nife.toArray(_obj).filter(Boolean);
    let parts     = [];

    for (let i = 0, il = elements.length; i < il; i++) {
      let element = elements[i];
      let tagName = element.tagName;
      if (!tagName)
        continue;

      let attrs = element.attributes || {};
      if (tagName === 'mj-image') {
        let src     = attrs.src;
        let width   = (attrs.width || 'auto').replace(/^(\d+)\D+$/, '$1');
        let height  = (attrs.height || 'auto').replace(/^(\d+)\D+$/, '$1');
        let style   = this.objectToStyleCSS({
          'border':           '0',
          'display':          'block',
          'outline':          'none',
          'text-decoration':  'none',
          'height':           'auto',
          'width':            '100%',
          ...(attrs),
          src:                null,
        });

        parts.push(`<img height="${height}" width="${width}" src="${src}" style="${style}"`);
      } else if (tagName === 'mj-text') {
        let style = this.objectToStyleCSS({
          'text-align': attrs.align || 'center',
          ...(attrs),
          align:        null,
        });

        parts.push(`<div style="${style}">${element.content || ''}</div>`);
      }
    }

    return parts.join('');
  }

  table(_props, ...rows) {
    let tableRows = rows.map((row) => {
      if (!row)
        return;

      let columns = row.columns.map((column) => {
        let props = column.attributes || {};
        let style = this.objectToStyleCSS({
          'padding-top':    '0px',
          'padding-right':  '0px',
          'padding-bottom': '0px',
          'padding-left':   '0px',
          'word-break':     'break-word',
          'width':          '100%',
          'vertical-align': 'top',
          ...(props),
        });

        return `<td align="${(props.align) ? props.align : 'left'}" style="${style}">${this.convertMJMLObjectToHTML(column.children || [])}</td>`;
      });

      let style = this.objectToStyleCSS({
        'overflow':   'hidden',
        'box-sizing': 'border-box',
        ...(row.attributes || {}),
      });

      return `<tr${(style) ? ` style="${style}"` : ''}>${columns.join('')}</tr>`;
    }).filter(Boolean);

    let props     = _props || {};
    let classes   = props['css-class'] || '';
    let classList = `hero-table${(classes) ? ` ${classes}` : ''}`;
    let style     = this.objectToStyleCSS({
      'border-spacing':   '0',
      'border-collapse':  'initial',
      ...(props.style || {}),
      'css-class':        null,
    });

    let content = [
      `<table class="${classList}" ${(style) ? `style="${style}"` : ''} cellpadding="0" cellspacing="0" role="presentation" width="100%">`,
      '<tbody>',
      tableRows.join(''),
      '</tbody>',
      '</table>',
    ].join('');

    return {
      tagName:    'mj-section',
      attributes: {},
      children:   [
        {
          tagName: 'mj-raw',
          content,
        },
      ],
    };
  }

  image(src, props) {
    return {
      tagName:    'mj-image',
      attributes: {
        'src':    src,
        'width':  this.sizePX(125),
        ...(props || {}),
      },
    };
  }

  text(content, props) {
    return {
      tagName:    'mj-text',
      attributes: {
        'align':        'center',
        'font-size':    this.sizePX(12),
        'line-height':  this.sizePX(22),
        'color':        BLACK_TEXT_COLOR,
        'font-family':  FONT_FAMILY,
        ...(props || {}),
      },
      content,
    };
  }

  icon(icon, props) {
    let style;

    if (props && props.style)
      style = this.objectToStyleCSS(props.style);

    return {
      tagName:    'mj-text',
      attributes: {
        'align':            'center',
        'font-size':        this.sizePX(20),
        'line-height':      this.sizePX(20),
        'color':            GREY_TEXT_COLOR,
        'font-family':      ICON_FONT,
        ...(props || {}),
      },
      content: `<div class="fas fa-${icon}" ${(style) ? `style="${style}"` : ''}></div>`,
    };
  }

  iconWithBox(name) {
    return this.icon(name, {
      style: {
        'background-color': MasterEmailTemplate.CONTAINER_BACKGROUND,
        'padding':          6,
        'border':           `1px solid ${MasterEmailTemplate.CONTAINER_BORDER}`,
        'border-radius':    MasterEmailTemplate.BORDER_RADIUS,
        'width':            36,
        'height':           36,
        'box-sizing':       'border-box',
      },
    });
  }

  header(content, props) {
    return {
      tagName:    'mj-text',
      attributes: {
        'align':        'center',
        'font-weight':  '600',
        'font-size':    this.sizePX(20),
        'line-height':  this.sizePX(28),
        'color':        BLACK_TEXT_COLOR,
        'font-family':  FONT_FAMILY,
        ...(props || {}),
      },
      content: `<span>${content}</span>`,
    };
  }

  button(caption, props) {
    return Object.assign(
      {},
      {
        tagName:    'mj-button',
        attributes: {
          'align':            'center',
          'font-family':      FONT_FAMILY,
          'color':            WHITE_TEXT_COLOR,
          'background-color': PRIMARY_COLOR,
          'inner-padding':    `${this.sizePX(14)} ${this.sizePX(28)}`,
          'font-size':        this.sizePX(16),
          'border-radius':    this.sizePX(BORDER_RADIUS),
          'title':            caption,
          ...(props || {}),
        },
        content: caption,
      },
    );
  }

  async render(_children) {
    let children = Nife.toArray(_children).filter(Boolean);

    let result = mjmlToHTML({
      tagName:    'mjml',
      attributes: {},
      children:   [
        {
          tagName:    'mj-head',
          attributes: {},
          children:   [
            {
              tagName:    'mj-font',
              attributes: {
                name: 'Inter',
                href: 'https://fonts.googleapis.com/css?family=Inter',
              },
            },
            // {
            //   tagName:    'mj-font',
            //   attributes: {
            //     name: 'Font Awesome 6 Free',
            //     href: 'https://example.com/assets/fonts/fontawesome/css/all.min.css',
            //   },
            // },
            {
              tagName:    'mj-style',
              attributes: {
                inline: 'inline',
              },
              content: `
                .hero-group {
                  background-color: #F9FAFB;
                  border: 1px solid #EEF1F5;
                  border-radius: ${this.sizePX(16)};
                  padding: ${this.sizePX(32)};
                  box-sizing: border-box;
                }
              `,
            },
            {
              tagName:    'mj-attributes',
              attributes: {},
              children:   [
                {
                  tagName:    'mj-section',
                  attributes: {
                    'padding': 0,
                  },
                },
                {
                  tagName:    'mj-column',
                  attributes: {
                    'padding': 0,
                  },
                },
                {
                  tagName:    'mj-image',
                  attributes: {
                    'padding-top':    '0px',
                    'padding-bottom': this.sizePX(18),
                    'padding-left':   '0px',
                    'padding-right':  '0px',
                  },
                },
                {
                  tagName:    'mj-text',
                  attributes: {
                    'padding-top':    '0px',
                    'padding-bottom': this.sizePX(18),
                    'padding-left':   '0px',
                    'padding-right':  '0px',
                  },
                },
              ],
            },
          ],
        },
        {
          tagName:    'mj-body',
          attributes: {},
          children:   [
            this.section(
              this.image(PRIMARY_ICON_IMAGE, { 'width': PRIMARY_ICON_IMAGE_SIZE }),
            ),
          ].concat(children, [
            this.section(
              this.divider({ 'padding-bottom': this.sizePX(18) }),
            ),
            this.sectionWithProps(
              {
                'background-color': CONTAINER_BACKGROUND,
                'border-radius':    this.sizePX(BORDER_RADIUS),
              },
              this.header(
                this.langTerm('email.generic.needHelp', 'Need Help?'),
                {
                  'padding-top':    this.sizePX(24),
                  'padding-bottom': this.sizePX(8),
                  'font-size':      this.sizePX(16),
                  'line-height':    this.sizePX(24),
                },
              ),
              this.text(
                `<a href="${this.getHelpURL()}" target="_blank">${this.langTerm('email.generic.helpLink', 'We’re here, ready to talk')}</a>`,
                {
                  'padding-top':    this.sizePX(0),
                  'padding-bottom': this.sizePX(24),
                  'font-size':      this.sizePX(14),
                  'line-height':    this.sizePX(21),
                },
              ),
            ),
            this.sectionWithProps(
              {
                'padding-top': this.sizePX(34),
              },
              this.text(
                '15900 North 78th St, Suite 110 Scottsdale AZ 85260',
                {
                  'font-size':    this.sizePX(14),
                  'line-height':  this.sizePX(22),
                  'color':        GREY_TEXT_COLOR,
                  'align':        'left',
                },
              ),
              this.text(
                this.langTerm('email.generic.copyright', 'Copyright © 2022 Hero™. All rights reserved.'),
                {
                  'font-size':    this.sizePX(14),
                  'line-height':  this.sizePX(22),
                  'color':        GREY_TEXT_COLOR,
                  'align':        'left',
                },
              ),
            ),
          ]),
        },
      ],
    });

    return result.html;
  }
}
