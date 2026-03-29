(function () {
    function ensureAuth() {
        var token = localStorage.getItem('dentalprep_token');
        if (!token) {
            window.location.href = '/login/';
            return false;
        }
        return true;
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function normalizeLinks(items) {
        return Array.isArray(items) ? items : [];
    }

    function renderLinkList(items, emptyText) {
        var links = normalizeLinks(items);
        if (!links.length) {
            return '<p class="muted-note">' + escapeHtml(emptyText) + '</p>';
        }

        return '<div class="video-list">' + links.map(function (item, index) {
            var title = item && item.title ? item.title : ('Resource ' + (index + 1));
            var url = item && item.url ? item.url : '#';
            return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(title) + '</a>';
        }).join('') + '</div>';
    }

    async function fetchJson(path) {
        if (!window.DentalPrepApi || !window.DentalPrepApi.apiFetch) {
            throw new Error('API helper is unavailable');
        }
        return window.DentalPrepApi.apiFetch(path, { method: 'GET' });
    }

    function bindLogout() {
        var logoutButton = document.getElementById('logout-btn');
        if (!logoutButton) {
            return;
        }

        logoutButton.addEventListener('click', function () {
            localStorage.removeItem('dentalprep_token');
            window.location.href = '/login/';
        });
    }

    async function renderHomepage() {
        if (document.body.dataset.page !== 'home') {
            return;
        }

        var aboutText = document.getElementById('about-academy-text');
        if (!aboutText) {
            return;
        }

        try {
            var content = await fetchJson('/academy/content');
            aboutText.textContent = content && content.profile && content.profile.aboutAcademyText
                ? content.profile.aboutAcademyText
                : aboutText.textContent;
        } catch (_err) {
            // Keep fallback text if API fetch fails.
        }
    }

    async function renderSubjectPage() {
        var page = document.body.dataset.page;
        if (page !== 'subject' && page !== 'subject-standalone') {
            return;
        }

        var subjectKey = document.body.dataset.subjectKey || '';
        if (!subjectKey) {
            var params = new URLSearchParams(window.location.search);
            subjectKey = params.get('subject') || 'anatomy';
        }
        var titleEl = document.getElementById('subject-title');
        var introEl = document.getElementById('subject-intro');
        var blockContainer = document.getElementById('block-container');

        if (!titleEl || !introEl || !blockContainer) {
            return;
        }

        blockContainer.innerHTML = '<p class="muted-note">Loading subject content...</p>';

        try {
            var data = await fetchJson('/subjects/' + encodeURIComponent(subjectKey) + '/content');
            var subject = data.subject;
            titleEl.textContent = subject.title;
            introEl.textContent = subject.intro;

            blockContainer.innerHTML = (subject.blocks || []).map(function (block) {
                var topics = Array.isArray(block.topics) ? block.topics : [];
                var topicLine = topics.join(', ');

                return [
                    '<article class="block-card">',
                    '<span class="block-label">' + escapeHtml(block.blockTitle || block.blockKey) + '</span>',
                    '<ul class="block-topic-list">',
                    topics.map(function (topic) { return '<li>' + escapeHtml(topic) + '</li>'; }).join(''),
                    '</ul>',
                    '<div class="resource-list">',
                    '<div class="resource-item">',
                    '<h4>YouTube Lecture Links</h4>',
                    renderLinkList(block.videoItems, 'No lecture links uploaded yet.'),
                    '</div>',
                    '<div class="resource-item">',
                    '<h4>Preparation Notes</h4>',
                    block.noteText ? '<p>' + escapeHtml(block.noteText) + '</p>' : '<p>Focused notes for: ' + escapeHtml(topicLine || 'this block') + '</p>',
                    renderLinkList(block.noteResources, 'No note files uploaded yet.'),
                    '</div>',
                    '<div class="resource-item">',
                    '<h4>Clinical Content</h4>',
                    block.clinicalText ? '<p>' + escapeHtml(block.clinicalText) + '</p>' : '<p>Clinical highlights and practical relevance for this block.</p>',
                    renderLinkList(block.clinicalResources, 'No clinical resources uploaded yet.'),
                    '</div>',
                    '</div>',
                    '</article>'
                ].join('');
            }).join('');
        } catch (_err) {
            blockContainer.innerHTML = '<p class="muted-note">Unable to load this subject right now.</p>';
        }
    }

    async function renderGeneralOverview() {
        if (document.body.dataset.page !== 'general-overview') {
            return;
        }

        try {
            var data = await fetchJson('/academy/content');
            var overview = data && data.profile ? (data.profile.generalOverview || {}) : {};

            document.getElementById('overview-books').innerHTML = renderLinkList(overview.books, 'No books added yet.');
            document.getElementById('overview-premium').innerHTML = renderLinkList(overview.premiumNotes, 'No premium notes added yet.');
            document.getElementById('overview-slides').innerHTML = renderLinkList(overview.importantSlides, 'No important slides added yet.');
            document.getElementById('overview-short').innerHTML = renderLinkList(overview.shortNotes, 'No short notes added yet.');
            document.getElementById('overview-videos').innerHTML = renderLinkList(overview.videos, 'No overview videos added yet.');
        } catch (_err) {
            // Keep static fallback labels if fetch fails.
        }
    }

    async function renderAboutPage() {
        if (document.body.dataset.page !== 'about-academy') {
            return;
        }

        try {
            var data = await fetchJson('/academy/content');
            var about = data && data.profile ? (data.profile.aboutUs || {}) : {};

            var preview = document.getElementById('avatar-preview');
            if (preview && about.profileImageUrl) {
                preview.src = about.profileImageUrl;
            }

            document.getElementById('about-intro-video').innerHTML = renderLinkList(
                about.introVideoUrl ? [{ title: 'Watch Academy Intro Video', url: about.introVideoUrl }] : [],
                'No introductory video link added yet.'
            );
            document.getElementById('about-notes').innerHTML = renderLinkList(about.notes, 'No notes added yet.');
            document.getElementById('about-pdfs').innerHTML = renderLinkList(about.pdfResources, 'No PDF resources added yet.');

            var contactEmail = about.contactEmail ? '<p>Email: ' + escapeHtml(about.contactEmail) + '</p>' : '';
            var contactNumbers = Array.isArray(about.contactNumbers) ? about.contactNumbers : [];
            document.getElementById('about-contacts').innerHTML =
                contactEmail +
                (contactNumbers.length
                    ? contactNumbers.map(function (number) { return '<p>Contact: ' + escapeHtml(number) + '</p>'; }).join('')
                    : '<p class="muted-note">No contact numbers added yet.</p>');
        } catch (_err) {
            // Keep fallback values if API fetch fails.
        }

        var uploadInput = document.getElementById('profile-upload');
        var avatarPreview = document.getElementById('avatar-preview');
        if (uploadInput && avatarPreview) {
            uploadInput.addEventListener('change', function (event) {
                var file = event.target.files && event.target.files[0];
                if (!file) {
                    return;
                }
                avatarPreview.src = URL.createObjectURL(file);
            });
        }
    }

    document.addEventListener('DOMContentLoaded', async function () {
        if (!ensureAuth()) {
            return;
        }

        bindLogout();
        await renderHomepage();
        await renderSubjectPage();
        await renderGeneralOverview();
        await renderAboutPage();
    });
})();
