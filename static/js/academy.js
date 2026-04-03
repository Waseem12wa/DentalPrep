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

    function resolveResourceUrl(value) {
        var url = String(value || '').trim();
        if (!url) {
            return '#';
        }

        if (/^https?:\/\//i.test(url)) {
            return url;
        }

        var apiBase = (window.DentalPrepApi && typeof window.DentalPrepApi.getApiBase === 'function')
            ? String(window.DentalPrepApi.getApiBase() || '')
            : '';
        var apiOrigin = apiBase ? apiBase.replace(/\/api\/?$/, '') : '';

        // Route uploaded files through backend file endpoint for stable open/download behavior.
        var uploadMatch = url.match(/^\/?static\/uploads\/([^?#/]+)(?:[?#].*)?$/i);
        if (uploadMatch && uploadMatch[1]) {
            var filePath = '/api/files/' + encodeURIComponent(uploadMatch[1]);
            return apiOrigin ? (apiOrigin + filePath) : filePath;
        }

        return url;
    }

    function isValidResourceUrl(url) {
        var value = String(url || '').trim();
        return Boolean(value) && value !== '#';
    }

    function safeDecode(value) {
        try {
            return decodeURIComponent(value);
        } catch (_err) {
            return value;
        }
    }

    function parseYouTubeUrl(url) {
        var value = String(url || '').trim();
        if (!value) {
            return { videoId: '', playlistId: '' };
        }

        var decoded = safeDecode(value);
        var videoId = '';
        var playlistId = '';

        try {
            var parsed = new URL(decoded);
            var host = String(parsed.hostname || '').toLowerCase();
            var path = parsed.pathname || '';

            playlistId = parsed.searchParams.get('list') || '';

            if (host.indexOf('youtu.be') !== -1) {
                videoId = path.replace(/^\//, '').split('/')[0] || '';
            } else {
                videoId = parsed.searchParams.get('v') || '';
                if (!videoId) {
                    var embedMatch = path.match(/\/embed\/([a-zA-Z0-9_-]{6,})/);
                    videoId = embedMatch ? embedMatch[1] : '';
                }
            }
        } catch (_err) {
            var listMatch = decoded.match(/[?&]list=([a-zA-Z0-9_-]+)/);
            var watchMatch = decoded.match(/[?&]v=([a-zA-Z0-9_-]{6,})/);
            var shortMatch = decoded.match(/youtu\.be\/([a-zA-Z0-9_-]{6,})/);
            var embedMatch = decoded.match(/\/embed\/([a-zA-Z0-9_-]{6,})/);
            playlistId = listMatch ? listMatch[1] : '';
            videoId = watchMatch ? watchMatch[1] : (shortMatch ? shortMatch[1] : (embedMatch ? embedMatch[1] : ''));
        }

        return {
            videoId: videoId,
            playlistId: playlistId
        };
    }

    function isLikelyVideoFile(url) {
        return /\.(mp4|webm|ogg|mov|m4v)(\?|#|$)/i.test(String(url || '')) || String(url || '').indexOf('/static/uploads/') === 0;
    }

    function renderVideoItems(items, emptyText) {
        var links = normalizeLinks(items);
        if (!links.length) {
            return '<p class="muted-note">' + escapeHtml(emptyText) + '</p>';
        }

        var freeLinks = links.filter(function (item) { return String((item && item.accessLevel) || 'free') !== 'paid'; });
        var paidLinks = links.filter(function (item) { return String((item && item.accessLevel) || 'free') === 'paid'; });

        var renderCards = function (list, isPaid) {
            return list.map(function (item, index) {
            var title = item && item.title ? item.title : ('Video ' + (index + 1));
            var url = resolveResourceUrl(item && (item.fileUrl || item.url) ? (item.fileUrl || item.url) : '#');
            var parsedYoutube = parseYouTubeUrl(url);
            var playlistId = parsedYoutube.playlistId;
            var videoId = parsedYoutube.videoId;
            var isLocked = Boolean(item && item.isLocked) || (isPaid && !isValidResourceUrl(url));

            if (isLocked) {
                return [
                    '<div class="video-embed-card">',
                    '<h5>' + escapeHtml(title) + '</h5>',
                    '<div class="muted-note"><i class="fas fa-lock"></i> Paid content. Upgrade to access.</div>',
                    '</div>'
                ].join('');
            }

            if (playlistId) {
                return [
                    '<div class="video-embed-card">',
                    '<h5>' + escapeHtml(title) + ' (Playlist)</h5>',
                    '<div class="video-frame-wrap">',
                    '<iframe src="https://www.youtube.com/embed/videoseries?list=' + escapeHtml(playlistId) + '&rel=0" title="' + escapeHtml(title) + '" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>',
                    '</div>',
                    '</div>'
                ].join('');
            }

            if (videoId) {
                return [
                    '<div class="video-embed-card">',
                    '<h5>' + escapeHtml(title) + '</h5>',
                    '<div class="video-frame-wrap">',
                    '<iframe src="https://www.youtube.com/embed/' + escapeHtml(videoId) + '" title="' + escapeHtml(title) + '" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>',
                    '</div>',
                    '</div>'
                ].join('');
            }

            if (isLikelyVideoFile(url)) {
                return [
                    '<div class="video-embed-card">',
                    '<h5>' + escapeHtml(title) + '</h5>',
                    '<div class="video-frame-wrap">',
                    '<video controls preload="metadata" src="' + escapeHtml(url) + '"></video>',
                    '</div>',
                    '</div>'
                ].join('');
            }

            return [
                '<div class="video-embed-card">',
                '<h5>' + escapeHtml(title) + '</h5>',
                '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">Open resource</a>',
                '</div>'
            ].join('');
            }).join('');
        };

        var sections = [];
        if (freeLinks.length) {
            sections.push('<div style="font-weight:700;color:#166534;margin:0.6rem 0;">Free Demo</div><div class="video-embed-grid">' + renderCards(freeLinks, false) + '</div>');
        }
        if (paidLinks.length) {
            sections.push('<div style="font-weight:700;color:#92400e;margin:0.9rem 0 0.6rem;">Paid Content</div><div class="video-embed-grid">' + renderCards(paidLinks, true) + '</div>');
        }

        return sections.join('');
    }

    function renderLinkList(items, emptyText) {
        var links = normalizeLinks(items);
        if (!links.length) {
            return '<p class="muted-note">' + escapeHtml(emptyText) + '</p>';
        }

        var freeLinks = links.filter(function (item) { return String((item && item.accessLevel) || 'free') !== 'paid'; });
        var paidLinks = links.filter(function (item) { return String((item && item.accessLevel) || 'free') === 'paid'; });

        var renderRows = function (list, isPaid) {
            return list.map(function (item, index) {
            var title = item && item.title ? item.title : ('Resource ' + (index + 1));
            var url = resolveResourceUrl(item && (item.fileUrl || item.url) ? (item.fileUrl || item.url) : '#');
            var isLocked = Boolean(item && item.isLocked) || (isPaid && !isValidResourceUrl(url));
            if (isLocked) {
                return '<a href="#" class="locked-pdf-link" data-title="' + escapeHtml(title) + '" data-subject-key="' + escapeHtml(String(window.__currentSubjectKey || '')) + '" data-block-key="' + escapeHtml(String(window.__currentBlockKey || '')) + '" data-section-name="' + escapeHtml(String(window.__currentSectionName || '')) + '"><i class="fas fa-lock"></i> ' + escapeHtml(title) + ' (Paid content)</a>';
            }
            if (!isValidResourceUrl(url)) {
                return '<span class="muted-note">' + escapeHtml(title) + ' (file link unavailable)</span>';
            }
            return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(title) + '</a>';
            }).join('');
        };

        var sections = [];
        if (freeLinks.length) {
            sections.push('<div style="font-weight:700;color:#166534;margin:0.6rem 0;">Free Demo</div><div class="video-list">' + renderRows(freeLinks, false) + '</div>');
        }
        if (paidLinks.length) {
            sections.push('<div style="font-weight:700;color:#92400e;margin:0.9rem 0 0.6rem;">Paid Content</div><div class="video-list">' + renderRows(paidLinks, true) + '</div>');
        }

        return sections.join('');
    }

    function renderSimpleVideoList(items, emptyText) {
        var links = normalizeLinks(items);
        if (!links.length) {
            return '<p class="muted-note">' + escapeHtml(emptyText) + '</p>';
        }

        return '<div class="simple-video-grid">' + links.map(function (item, index) {
            var title = item && item.title ? item.title : ('Video ' + (index + 1));
            var url = resolveResourceUrl(item && (item.fileUrl || item.url) ? (item.fileUrl || item.url) : '#');
            
            if (isLikelyVideoFile(url)) {
                return [
                    '<div class="video-card-simple">',
                    '<h5>' + escapeHtml(title) + '</h5>',
                    '<video controls preload="metadata" style="width: 100%; max-width: 300px;">',
                    '<source src="' + escapeHtml(url) + '">',
                    'Your browser does not support the video tag.',
                    '</video>',
                    '</div>'
                ].join('');
            }

            return [
                '<div class="video-card-simple">',
                '<h5>' + escapeHtml(title) + '</h5>',
                (isValidResourceUrl(url)
                    ? ('<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer" class="video-link-btn">Watch Video</a>')
                    : '<span class="muted-note">Video link unavailable</span>'),
                '</div>'
            ].join('');
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
        var dynamicCoursesGrid = document.getElementById('dynamic-courses-grid');
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

        if (!dynamicCoursesGrid) {
            return;
        }

        try {
            var courseData = await fetchJson('/courses');
            var courses = Array.isArray(courseData && courseData.courses) ? courseData.courses : [];

            if (!courses.length) {
                dynamicCoursesGrid.innerHTML = '<p class="muted-note">No courses available yet. Ask admin to create a course.</p>';
                return;
            }

            dynamicCoursesGrid.innerHTML = courses.map(function (course) {
                var title = escapeHtml(course.title || 'Untitled Course');
                var description = escapeHtml(course.description || 'Course content with lessons and quizzes.');
                var lessonCount = Number(course.lessonsCount || 0);
                var quizCount = Number(course.quizCount || 0);
                return [
                    '<a class="academy-box" href="/course-player/?id=' + encodeURIComponent(course.id || '') + '">',
                    '<h3>' + title + '</h3>',
                    '<p>' + description + '</p>',
                    '<p style="margin-top: 0.4rem; font-weight: 700;">' + lessonCount + ' lesson(s) • ' + quizCount + ' quiz(zes)</p>',
                    '</a>'
                ].join('');
            }).join('');
        } catch (_err) {
            dynamicCoursesGrid.innerHTML = '<p class="muted-note">Unable to load your courses right now.</p>';
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
        window.__currentSubjectKey = subjectKey;

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
                var sections = Array.isArray(block.sections) ? block.sections : [];
                var sectionList = sections.length
                    ? sections
                    : topics.map(function (topicName) {
                        return {
                            name: topicName,
                            videoItems: [],
                            noteText: '',
                            noteResources: [],
                            clinicalText: '',
                            clinicalResources: []
                        };
                    });

                if (sectionList.length > 0) {
                    var sectionsHtml = sectionList.map(function (section) {
                        window.__currentBlockKey = block.blockKey || '';
                        window.__currentSectionName = section.name || '';
                        return [
                            '<div class="block-section module-folder-card">',
                            '<h5 class="section-title"><i class="fas fa-folder-open" style="margin-right:0.45rem;color:#1f3f81;"></i>' + escapeHtml(section.name || 'Module') + '</h5>',
                            '<div class="section-resources">',
                            '<div class="resource-item">',
                            '<h4>YouTube Lecture Links</h4>',
                            renderVideoItems(section.videoItems, 'No lecture links uploaded yet.'),
                            '</div>',
                            '<div class="resource-item">',
                            '<h4>Preparation Notes</h4>',
                            section.noteText ? '<p>' + escapeHtml(section.noteText) + '</p>' : '<p>Focused notes for: ' + escapeHtml(section.name || 'this module') + '</p>',
                            renderLinkList(section.noteResources, 'No note files uploaded yet.'),
                            '</div>',
                            '<div class="resource-item">',
                            '<h4>Clinical Content</h4>',
                            section.clinicalText ? '<p>' + escapeHtml(section.clinicalText) + '</p>' : '<p>Clinical highlights and practical relevance for this module.</p>',
                            renderLinkList(section.clinicalResources, 'No clinical resources uploaded yet.'),
                            '</div>',
                            '</div>',
                            '</div>'
                        ].join('');
                    }).join('');

                    window.__currentBlockKey = block.blockKey || '';
                    window.__currentSectionName = '';
                    return [
                        '<article class="block-card">',
                        '<span class="block-label">' + escapeHtml(block.blockTitle || block.blockKey) + '</span>',
                        '<div class="sections-container module-folder-grid">',
                        sectionsHtml,
                        '</div>',
                        '</article>'
                    ].join('');
                }

                return [
                    '<article class="block-card">',
                    '<span class="block-label">' + escapeHtml(block.blockTitle || block.blockKey) + '</span>',
                    '<div class="resource-list">',
                    '<div class="resource-item">',
                    '<h4>YouTube Lecture Links</h4>',
                    renderVideoItems(block.videoItems, 'No lecture links uploaded yet.'),
                    '</div>',
                    '<div class="resource-item">',
                    '<h4>Preparation Notes</h4>',
                    block.noteText ? '<p>' + escapeHtml(block.noteText) + '</p>' : '<p>Focused notes for this block.</p>',
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

            blockContainer.querySelectorAll('.locked-pdf-link').forEach(function (link) {
                link.addEventListener('click', async function (event) {
                    event.preventDefault();
                    var subjectKeyVal = String(link.getAttribute('data-subject-key') || subjectKey || '').trim();
                    var blockKeyVal = String(link.getAttribute('data-block-key') || '').trim();
                    var sectionNameVal = String(link.getAttribute('data-section-name') || '').trim();
                    var resourceTitle = String(link.getAttribute('data-title') || 'Paid PDF').trim();

                    var promptText = [
                        'This PDF is paid content (PKR 300).',
                        'Easypaisa Number: 03327939323',
                        'Account Name: Muhammad Yousaf',
                        'After payment, enter proof/reference below and submit request for admin approval.',
                        '',
                        'Resource: ' + resourceTitle,
                        'Block: ' + blockKeyVal,
                        'Module: ' + sectionNameVal,
                        '',
                        'Enter payment proof/reference ID:'
                    ].join('\n');

                    var paymentProof = window.prompt(promptText, 'EP Transaction ID / Screenshot note');
                    if (paymentProof === null) {
                        return;
                    }

                    try {
                        await fetchJson('/pdf-access/request', {
                            method: 'POST',
                            body: JSON.stringify({
                                subjectKey: subjectKeyVal,
                                blockKey: blockKeyVal,
                                sectionName: sectionNameVal,
                                paymentProof: paymentProof
                            })
                        });
                        window.alert('Payment request submitted. Admin will verify and approve access manually.');
                    } catch (err) {
                        window.alert((err && err.message) ? err.message : 'Unable to submit payment request right now.');
                    }
                });
            });
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
            document.getElementById('overview-videos').innerHTML = renderSimpleVideoList(overview.videos, 'No overview videos added yet.');
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
            document.getElementById('about-intro-video').innerHTML = renderVideoItems(
                about.introVideoUrl ? [{ title: 'Academy Intro Video', url: about.introVideoUrl }] : [],
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

        // Profile image is admin-managed only.
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
