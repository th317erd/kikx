'use strict';

// =============================================================================
// kikx-user-avatar — circular avatar component
// =============================================================================
// Priority: avatar-data (base64) > Gravatar (email) > initials fallback
// Attributes: email, first-name, last-name, avatar-data, size (px, default 32)
// =============================================================================

// Minimal MD5 for Gravatar URL generation (RFC 1321 — NOT cryptographic use)
function md5(input) {
  function rotateLeft(value, shift) {
    return (value << shift) | (value >>> (32 - shift));
  }

  function addUnsigned(x, y) {
    let result = (x & 0x7FFFFFFF) + (y & 0x7FFFFFFF);
    if (x & 0x80000000) result ^= 0x80000000;
    if (y & 0x80000000) result ^= 0x80000000;
    return result;
  }

  function F(x, y, z) { return (x & y) | (~x & z); }
  function G(x, y, z) { return (x & z) | (y & ~z); }
  function H(x, y, z) { return x ^ y ^ z; }
  function I(x, y, z) { return y ^ (x | ~z); }

  function step(func, a, b, c, d, x, s, ac) {
    a = addUnsigned(a, addUnsigned(addUnsigned(func(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }

  function utf8Encode(string) {
    let output = '';
    for (let n = 0; n < string.length; n++) {
      let charCode = string.charCodeAt(n);
      if (charCode < 128) {
        output += String.fromCharCode(charCode);
      } else if (charCode < 2048) {
        output += String.fromCharCode((charCode >> 6) | 192);
        output += String.fromCharCode((charCode & 63) | 128);
      } else {
        output += String.fromCharCode((charCode >> 12) | 224);
        output += String.fromCharCode(((charCode >> 6) & 63) | 128);
        output += String.fromCharCode((charCode & 63) | 128);
      }
    }
    return output;
  }

  function wordToHex(value) {
    let result = '';
    for (let count = 0; count <= 3; count++) {
      result += '0123456789abcdef'.charAt((value >> (count * 8 + 4)) & 0x0F);
      result += '0123456789abcdef'.charAt((value >> (count * 8)) & 0x0F);
    }
    return result;
  }

  let str = utf8Encode(input);
  let x   = [];
  let k;
  let AA;
  let BB;
  let CC;
  let DD;
  let a;
  let b;
  let c;
  let d;

  let S11 = 7;  let S12 = 12; let S13 = 17; let S14 = 22;
  let S21 = 5;  let S22 = 9;  let S23 = 14; let S24 = 20;
  let S31 = 4;  let S32 = 11; let S33 = 16; let S34 = 23;
  let S41 = 6;  let S42 = 10; let S43 = 15; let S44 = 21;

  let strLen = str.length;
  let wordCount = ((strLen + 8) >> 6) + 1;

  for (k = 0; k < wordCount * 16; k++)
    x[k] = 0;

  for (k = 0; k < strLen; k++)
    x[k >> 2] |= str.charCodeAt(k) << ((k % 4) * 8);

  x[k >> 2] |= 0x80 << ((k % 4) * 8);
  x[wordCount * 16 - 2] = strLen * 8;

  a = 0x67452301;
  b = 0xEFCDAB89;
  c = 0x98BADCFE;
  d = 0x10325476;

  for (k = 0; k < x.length; k += 16) {
    AA = a; BB = b; CC = c; DD = d;

    a = step(F, a, b, c, d, x[k + 0],  S11, 0xD76AA478);
    d = step(F, d, a, b, c, x[k + 1],  S12, 0xE8C7B756);
    c = step(F, c, d, a, b, x[k + 2],  S13, 0x242070DB);
    b = step(F, b, c, d, a, x[k + 3],  S14, 0xC1BDCEEE);
    a = step(F, a, b, c, d, x[k + 4],  S11, 0xF57C0FAF);
    d = step(F, d, a, b, c, x[k + 5],  S12, 0x4787C62A);
    c = step(F, c, d, a, b, x[k + 6],  S13, 0xA8304613);
    b = step(F, b, c, d, a, x[k + 7],  S14, 0xFD469501);
    a = step(F, a, b, c, d, x[k + 8],  S11, 0x698098D8);
    d = step(F, d, a, b, c, x[k + 9],  S12, 0x8B44F7AF);
    c = step(F, c, d, a, b, x[k + 10], S13, 0xFFFF5BB1);
    b = step(F, b, c, d, a, x[k + 11], S14, 0x895CD7BE);
    a = step(F, a, b, c, d, x[k + 12], S11, 0x6B901122);
    d = step(F, d, a, b, c, x[k + 13], S12, 0xFD987193);
    c = step(F, c, d, a, b, x[k + 14], S13, 0xA679438E);
    b = step(F, b, c, d, a, x[k + 15], S14, 0x49B40821);

    a = step(G, a, b, c, d, x[k + 1],  S21, 0xF61E2562);
    d = step(G, d, a, b, c, x[k + 6],  S22, 0xC040B340);
    c = step(G, c, d, a, b, x[k + 11], S23, 0x265E5A51);
    b = step(G, b, c, d, a, x[k + 0],  S24, 0xE9B6C7AA);
    a = step(G, a, b, c, d, x[k + 5],  S21, 0xD62F105D);
    d = step(G, d, a, b, c, x[k + 10], S22, 0x02441453);
    c = step(G, c, d, a, b, x[k + 15], S23, 0xD8A1E681);
    b = step(G, b, c, d, a, x[k + 4],  S24, 0xE7D3FBC8);
    a = step(G, a, b, c, d, x[k + 9],  S21, 0x21E1CDE6);
    d = step(G, d, a, b, c, x[k + 14], S22, 0xC33707D6);
    c = step(G, c, d, a, b, x[k + 3],  S23, 0xF4D50D87);
    b = step(G, b, c, d, a, x[k + 8],  S24, 0x455A14ED);
    a = step(G, a, b, c, d, x[k + 13], S21, 0xA9E3E905);
    d = step(G, d, a, b, c, x[k + 2],  S22, 0xFCEFA3F8);
    c = step(G, c, d, a, b, x[k + 7],  S23, 0x676F02D9);
    b = step(G, b, c, d, a, x[k + 12], S24, 0x8D2A4C8A);

    a = step(H, a, b, c, d, x[k + 5],  S31, 0xFFFA3942);
    d = step(H, d, a, b, c, x[k + 8],  S32, 0x8771F681);
    c = step(H, c, d, a, b, x[k + 11], S33, 0x6D9D6122);
    b = step(H, b, c, d, a, x[k + 14], S34, 0xFDE5380C);
    a = step(H, a, b, c, d, x[k + 1],  S31, 0xA4BEEA44);
    d = step(H, d, a, b, c, x[k + 4],  S32, 0x4BDECFA9);
    c = step(H, c, d, a, b, x[k + 7],  S33, 0xF6BB4B60);
    b = step(H, b, c, d, a, x[k + 10], S34, 0xBEBFBC70);
    a = step(H, a, b, c, d, x[k + 13], S31, 0x289B7EC6);
    d = step(H, d, a, b, c, x[k + 0],  S32, 0xEAA127FA);
    c = step(H, c, d, a, b, x[k + 3],  S33, 0xD4EF3085);
    b = step(H, b, c, d, a, x[k + 6],  S34, 0x04881D05);
    a = step(H, a, b, c, d, x[k + 9],  S31, 0xD9D4D039);
    d = step(H, d, a, b, c, x[k + 12], S32, 0xE6DB99E5);
    c = step(H, c, d, a, b, x[k + 15], S33, 0x1FA27CF8);
    b = step(H, b, c, d, a, x[k + 2],  S34, 0xC4AC5665);

    a = step(I, a, b, c, d, x[k + 0],  S41, 0xF4292244);
    d = step(I, d, a, b, c, x[k + 7],  S42, 0x432AFF97);
    c = step(I, c, d, a, b, x[k + 14], S43, 0xAB9423A7);
    b = step(I, b, c, d, a, x[k + 5],  S44, 0xFC93A039);
    a = step(I, a, b, c, d, x[k + 12], S41, 0x655B59C3);
    d = step(I, d, a, b, c, x[k + 3],  S42, 0x8F0CCC92);
    c = step(I, c, d, a, b, x[k + 10], S43, 0xFFEFF47D);
    b = step(I, b, c, d, a, x[k + 1],  S44, 0x85845DD1);
    a = step(I, a, b, c, d, x[k + 8],  S41, 0x6FA87E4F);
    d = step(I, d, a, b, c, x[k + 15], S42, 0xFE2CE6E0);
    c = step(I, c, d, a, b, x[k + 6],  S43, 0xA3014314);
    b = step(I, b, c, d, a, x[k + 13], S44, 0x4E0811A1);
    a = step(I, a, b, c, d, x[k + 4],  S41, 0xF7537E82);
    d = step(I, d, a, b, c, x[k + 11], S42, 0xBD3AF235);
    c = step(I, c, d, a, b, x[k + 2],  S43, 0x2AD7D2BB);
    b = step(I, b, c, d, a, x[k + 9],  S44, 0xEB86D391);

    a = addUnsigned(a, AA);
    b = addUnsigned(b, BB);
    c = addUnsigned(c, CC);
    d = addUnsigned(d, DD);
  }

  return wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d);
}

function getInitials(firstName, lastName, email) {
  if (firstName && lastName)
    return (firstName[0] + lastName[0]).toUpperCase();

  if (firstName)
    return firstName.substring(0, 2).toUpperCase();

  if (email)
    return email.substring(0, 2).toUpperCase();

  return '??';
}

const TEMPLATE_HTML = `
  <style>
    :host {
      display: inline-block;
      line-height: 0;
    }

    .avatar {
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      overflow: hidden;
      background: var(--accent-primary, #00e5ff);
      cursor: inherit;
    }

    .avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .initials {
      color: var(--text-inverse, #0a0a1a);
      font-weight: 600;
      user-select: none;
    }
  </style>
  <div class="avatar">
    <img class="avatar-image" style="display:none" />
    <span class="initials"></span>
  </div>
`;

let cachedTemplate = null;

function getTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = document.createElement('template');
    cachedTemplate.innerHTML = TEMPLATE_HTML;
  }

  return cachedTemplate;
}

class KikxUserAvatar extends HTMLElement {
  static get observedAttributes() {
    return ['email', 'first-name', 'last-name', 'avatar-data', 'size'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._container = this.shadowRoot.querySelector('.avatar');
    this._image     = this.shadowRoot.querySelector('.avatar-image');
    this._initials  = this.shadowRoot.querySelector('.initials');

    this._onImageError = this._onImageError.bind(this);
  }

  connectedCallback() {
    this._image.addEventListener('error', this._onImageError);
    this._render();
  }

  disconnectedCallback() {
    this._image.removeEventListener('error', this._onImageError);
  }

  attributeChangedCallback() {
    if (this._container)
      this._render();
  }

  _render() {
    let size      = parseInt(this.getAttribute('size'), 10) || 32;
    let avatarData = this.getAttribute('avatar-data');
    let email     = this.getAttribute('email');
    let firstName = this.getAttribute('first-name');
    let lastName  = this.getAttribute('last-name');

    this._container.style.width    = `${size}px`;
    this._container.style.height   = `${size}px`;
    this._initials.style.fontSize  = `${Math.max(10, Math.round(size * 0.4))}px`;

    let initialsText = getInitials(firstName, lastName, email);
    this._initials.textContent = initialsText;

    if (avatarData) {
      let src = avatarData.startsWith('data:')
        ? avatarData
        : `data:image/png;base64,${avatarData}`;

      this._image.src = src;
      this._image.style.display = 'block';
      this._initials.style.display = 'none';
    } else if (email) {
      let hash = md5(email.trim().toLowerCase());
      this._image.src = `https://gravatar.com/avatar/${hash}?d=404&s=${size}`;
      this._image.style.display = 'block';
      this._initials.style.display = 'none';
    } else {
      this._image.style.display = 'none';
      this._initials.style.display = '';
    }
  }

  _onImageError() {
    this._image.style.display = 'none';
    this._initials.style.display = '';
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-user-avatar', KikxUserAvatar);

export { md5 };
export default KikxUserAvatar;
