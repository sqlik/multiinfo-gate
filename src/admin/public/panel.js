// Jedyny JavaScript panelu: zamykanie paska komunikatu (x, Esc) i okno potwierdzenia
// dla formularzy z data-confirm. Bez tego pliku pasek zostaje do następnego przejścia,
// a formularz wysyła się bez pytania - panel działa, tylko mniej wygodnie.
(function () {
  var flash = document.querySelector('.flash');
  var closeFlash = function () { if (flash) { flash.remove(); flash = null; } };
  if (flash) {
    var button = flash.querySelector('.flash-close');
    if (button) button.addEventListener('click', closeFlash);
  }

  var backdrop = null;
  var closeModal = function () { if (backdrop) { backdrop.remove(); backdrop = null; } };

  var openModal = function (form) {
    closeModal();
    backdrop = document.createElement('div');
    backdrop.className = 'modal-back';
    var box = document.createElement('div');
    box.className = 'modal';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    var text = document.createElement('p');
    text.textContent = form.getAttribute('data-confirm');
    var actions = document.createElement('div');
    actions.className = 'modal-actions';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-s';
    cancel.textContent = 'Anuluj';
    var ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn btn-p';
    ok.textContent = form.getAttribute('data-confirm-ok') || 'Tak';
    cancel.addEventListener('click', closeModal);
    // form.submit() nie wyzwala zdarzenia submit, więc nie wpadamy w pętlę pytań.
    ok.addEventListener('click', function () { closeModal(); form.submit(); });
    backdrop.addEventListener('click', function (event) { if (event.target === backdrop) closeModal(); });
    actions.appendChild(cancel);
    actions.appendChild(ok);
    box.appendChild(text);
    box.appendChild(actions);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
    cancel.focus();
  };

  var forms = document.querySelectorAll('form[data-confirm]');
  for (var i = 0; i < forms.length; i += 1) {
    forms[i].addEventListener('submit', function (event) {
      event.preventDefault();
      openModal(event.target);
    });
  }

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (backdrop) closeModal(); else closeFlash();
  });
})();
