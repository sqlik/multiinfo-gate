// Jedyny JavaScript panelu: zamykanie paska komunikatu (x, Esc), okno potwierdzenia
// dla formularzy z data-confirm i przycisk kopiowania (data-copy). Bez tego pliku pasek
// zostaje do następnego przejścia, formularz wysyła się bez pytania, a adres trzeba
// zaznaczyć ręcznie - panel działa, tylko mniej wygodnie.
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

  // Kopiowanie treści wskazanego elementu; etykieta potwierdza na dwie sekundy.
  var copies = document.querySelectorAll('[data-copy]');
  for (var c = 0; c < copies.length; c += 1) {
    copies[c].addEventListener('click', function (event) {
      var button = event.currentTarget;
      var source = document.querySelector(button.getAttribute('data-copy'));
      if (!source || !navigator.clipboard) return;
      var label = button.textContent;
      navigator.clipboard.writeText(source.textContent.trim()).then(function () {
        button.textContent = 'Skopiowano';
        setTimeout(function () { button.textContent = label; }, 2000);
      });
    });
  }
})();
