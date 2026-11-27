import sanitizeHtml from 'sanitize-html';

/** Rich text is limited to a small tag set. Scripts, styles and event handlers are removed. */
export function cleanHtml(value = '') {
  return sanitizeHtml(value, {
    allowedTags: ['p', 'br', 'h2', 'h3', 'ul', 'ol', 'li', 'strong', 'em', 'a'],
    allowedAttributes: { a: ['href', 'rel'] },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowProtocolRelative: false,
    nonTextTags: ['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'noscript', 'textarea', 'option'],
    // Keep the meaning of tags the editor may produce.
    transformTags: {
      b: 'strong', i: 'em', h1: 'h2', h4: 'h3', div: 'p',
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, rel: 'noopener noreferrer' } }),
    },
  });
}
