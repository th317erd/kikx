export function formatPhoneNumber(phoneNumber, target) {
  // TODO: @I18N

  let numberRaw = ('' + phoneNumber).replace(/\D/g, '');
  if (!(/(\d{1,3})?(\d{3})(\d{3})(\d{4})$/).test(numberRaw))
    return null;

  let phone = numberRaw.replace(/(\d{1,3})?(\d{3})(\d{3})(\d{4})$/, (m, p1, p2, p3, p4) => {
    let parts = [ p1, p2, p3, p4 ].filter(Boolean).join('-');
    return (p1) ? `+${parts}` : `+1-${parts}`;
  });

  if (target === 'DB')
    return phone.replace(/\D/g, '');

  return phone;
}
