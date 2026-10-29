(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const form = $('form'), textarea = $('question'), messages = $('messages');
  const status = $('status'), send = $('send');
  function addMessage(text, role, sources=[]) {
    const bubble = document.createElement('div');
    bubble.className = `message ${role}`;
    bubble.textContent = text; // Never insert AI responses as HTML.
    messages.appendChild(bubble);
    if (sources.length) {
      const note = document.createElement('div');
      note.className = 'sources';
      note.textContent = 'Source documents: ' + sources.join(', ');
      messages.appendChild(note);
    }
    messages.scrollTop = messages.scrollHeight;
  }
  const githubPages = location.hostname.endsWith('.github.io');
  status.textContent = githubPages ? 'Backend requires deployment' : 'Local API';
  for (const button of document.querySelectorAll('[data-prompt]')) {
    button.addEventListener('click', () => { textarea.value = button.dataset.prompt; textarea.focus(); });
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const question = textarea.value.trim();
    if (!question || send.disabled) return;
    if (githubPages) {
      addMessage('This AI requires a Node.js backend and cannot run on GitHub Pages alone. Run locally with npm start, or deploy the backend later. / المرشد الذكي يحتاج سيرفر Node.js وليس GitHub Pages فقط.', 'assistant');
      return;
    }
    addMessage(question, 'user');
    textarea.value = '';
    send.disabled = true;
    status.textContent = 'Searching verified sources…';
    try {
      const response = await fetch('/api/ai/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ question }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Service temporarily unavailable.');
      addMessage(data.answer || 'No answer available.', 'assistant', data.sources || []);
      status.textContent = 'Ready';
    } catch (error) {
      addMessage(error.message || 'Connection failed. Please try again.', 'assistant');
      status.textContent = 'Setup needed';
    } finally {
      send.disabled = false;
    }
  });
})();
