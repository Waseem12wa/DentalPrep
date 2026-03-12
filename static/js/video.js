document.addEventListener("DOMContentLoaded", async () => {
  const api = window.DentalPrepApi;
  if (!api) return;
  if (!api.requireAuth()) return;

  const params = new URLSearchParams(window.location.search);
  const lessonId = params.get("id");

  const titleEl = document.getElementById("video-title");
  const metaEl = document.getElementById("video-meta");
  const chipsEl = document.getElementById("lesson-chips");
  const summaryEl = document.getElementById("lesson-summary");
  const audioListEl = document.getElementById("audio-list");
  const materialListEl = document.getElementById("material-list");
  const caseListEl = document.getElementById("case-study-list");
  const assistantForm = document.getElementById("assistant-form");
  const assistantPrompt = document.getElementById("assistant-prompt");
  const assistantResponse = document.getElementById("assistant-response");
  const assistantHistory = document.getElementById("assistant-history");
  const assistantLink = document.getElementById("assistant-link");
  const completeBtn = document.getElementById("mark-complete");
  const backLink = document.getElementById("back-link");
  const quizLink = document.getElementById("start-quiz");
  const player = document.getElementById("video-player");

  let lesson = null;
  let completionLocked = false;

  const escapeHtml = (value) => String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");

  const toAssetUrl = (value) => {
    const url = String(value || "").trim();
    if (!url) return "";
    if (/^https?:\/\//i.test(url)) return url;
    return `${window.location.origin}${url.startsWith("/") ? url : `/${url}`}`;
  };

  const extractYoutubeId = (url) => {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/,
      /v=([^&]+)/,
      /youtube\.com\/embed\/([^&\n?#]+)/
    ];

    for (const pattern of patterns) {
      const match = String(url || "").match(pattern);
      if (match) return match[1];
    }
    return null;
  };

  const setCompletedState = (isCompleted) => {
    if (!completeBtn) return;
    completeBtn.textContent = isCompleted ? "Completed" : "Mark Completed";
    completeBtn.disabled = Boolean(isCompleted);
    completionLocked = Boolean(isCompleted);
  };

  const markLessonComplete = async () => {
    if (!lesson || completionLocked) return;
    await api.apiFetch("/progress", {
      method: "POST",
      body: JSON.stringify({
        courseId: lesson.courseId,
        lessonId: lesson.id,
        itemType: "lesson",
        title: lesson.title,
        completed: true,
        score: 0
      })
    });
    setCompletedState(true);
  };

  const loadYoutubeApi = (() => {
    let pendingPromise = null;
    return () => {
      if (window.YT && window.YT.Player) {
        return Promise.resolve(window.YT);
      }
      if (pendingPromise) {
        return pendingPromise;
      }
      pendingPromise = new Promise((resolve) => {
        const previousHandler = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => {
          if (typeof previousHandler === "function") {
            previousHandler();
          }
          resolve(window.YT);
        };
        const script = document.createElement("script");
        script.src = "https://www.youtube.com/iframe_api";
        document.head.appendChild(script);
      });
      return pendingPromise;
    };
  })();

  const renderAssistantHistory = (items) => {
    if (!assistantHistory) return;
    if (!items.length) {
      assistantHistory.innerHTML = '<div class="history-item" style="color: #6b7280;">No AI explanations yet for this lesson.</div>';
      return;
    }

    assistantHistory.innerHTML = items.map((item) => `
      <div class="history-item">
        <div style="font-weight: 700; color: #111827; margin-bottom: 0.5rem;">${escapeHtml(item.prompt)}</div>
        <div style="white-space: pre-wrap; color: #4b5563; line-height: 1.6;">${escapeHtml(item.response)}</div>
        ${item.sourceTitles && item.sourceTitles.length ? `<div style="margin-top: 0.75rem; color: #6b7280; font-size: 0.875rem;">Sources: ${escapeHtml(item.sourceTitles.join(", "))}</div>` : ""}
      </div>
    `).join("");
  };

  const loadAssistantHistory = async () => {
    if (!lesson) return;
    try {
      const historyData = await api.apiFetch(`/assistant/history?courseId=${encodeURIComponent(lesson.courseId)}&lessonId=${encodeURIComponent(lesson.id)}`);
      renderAssistantHistory(historyData.chats || []);
    } catch (_err) {
      renderAssistantHistory([]);
    }
  };

  const renderAudioItems = (audioItems) => {
    if (!audioListEl) return;
    if (!audioItems.length) {
      audioListEl.innerHTML = '<div class="resource-item empty-copy">No audio lesson files were added for this lesson.</div>';
      return;
    }

    audioListEl.innerHTML = audioItems.map((audio) => `
      <div class="resource-item">
        <div style="font-weight: 700; color: #111827; margin-bottom: 0.5rem;">${escapeHtml(audio.title || audio.fileName || "Audio Lesson")}</div>
        <audio controls preload="metadata" data-autocomplete="lesson-audio" style="width: 100%;">
          <source src="${toAssetUrl(audio.fileUrl)}">
          Your browser does not support the audio element.
        </audio>
      </div>
    `).join("");

    audioListEl.querySelectorAll("audio[data-autocomplete='lesson-audio']").forEach((audioEl) => {
      audioEl.addEventListener("ended", async () => {
        try {
          await markLessonComplete();
        } catch (_err) {
          // Ignore autoplay completion failures; manual completion remains available.
        }
      });
    });
  };

  const renderMaterials = (materials) => {
    if (!materialListEl) return;
    if (!materials.length) {
      materialListEl.innerHTML = '<div class="resource-item empty-copy">No study materials uploaded for this lesson yet.</div>';
      return;
    }

    materialListEl.innerHTML = materials.map((material) => `
      <div class="resource-item">
        <div style="font-weight: 700; color: #111827;">${escapeHtml(material.title || material.fileName || "Material")}</div>
        <div style="color: #6b7280; font-size: 0.9rem; margin: 0.4rem 0 0.9rem;">${escapeHtml(material.fileName || material.mimeType || "Study file")}</div>
        <div style="display: flex; gap: 0.75rem; flex-wrap: wrap;">
          <a class="btn-primary" style="text-decoration: none; display: inline-flex; align-items: center;" href="${toAssetUrl(material.fileUrl)}" target="_blank" rel="noopener noreferrer">Open</a>
          <a class="btn-primary" style="text-decoration: none; display: inline-flex; align-items: center;" href="${toAssetUrl(material.fileUrl)}" download>Download</a>
        </div>
      </div>
    `).join("");
  };

  const renderCaseStudies = (caseStudies) => {
    if (!caseListEl) return;
    if (!caseStudies.length) {
      caseListEl.innerHTML = '<div class="case-item empty-copy">No clinical case studies added for this lesson yet.</div>';
      return;
    }

    caseListEl.innerHTML = caseStudies.map((item) => `
      <div class="case-item">
        <div style="font-weight: 700; color: #111827; margin-bottom: 0.5rem;">${escapeHtml(item.title || "Clinical Case")}</div>
        ${item.scenario ? `<div style="margin-bottom: 0.5rem;"><strong>Scenario:</strong> ${escapeHtml(item.scenario)}</div>` : ""}
        ${item.diagnosis ? `<div style="margin-bottom: 0.5rem;"><strong>Diagnosis:</strong> ${escapeHtml(item.diagnosis)}</div>` : ""}
        ${item.discussion ? `<div style="margin-bottom: 0.5rem;"><strong>Discussion:</strong> ${escapeHtml(item.discussion)}</div>` : ""}
        ${item.relevance ? `<div><strong>Relevance:</strong> ${escapeHtml(item.relevance)}</div>` : ""}
      </div>
    `).join("");
  };

  const renderPlayer = async () => {
    if (!player || !lesson) return;

    if (!lesson.videoUrl) {
      player.innerHTML = `
        <div style="padding: 2rem; text-align: center; color: white;">
          <i class="fas fa-headphones" style="font-size: 2rem; margin-bottom: 1rem;"></i>
          <p>This lesson does not include a video file. Use the audio lessons, study materials, and case studies below.</p>
        </div>
      `;
      return;
    }

    if (lesson.videoType === "upload") {
      player.innerHTML = `
        <video controls preload="metadata" style="width: 100%; max-height: 520px; border-radius: 1rem; background: #111827; display: block;" controlsList="nodownload">
          <source src="${toAssetUrl(lesson.videoUrl)}">
          Your browser does not support the video tag.
        </video>
      `;
      player.style.height = "auto";
      const media = player.querySelector("video");
      if (media) {
        media.addEventListener("ended", async () => {
          try {
            await markLessonComplete();
          } catch (_err) {
            // Ignore; manual completion remains available.
          }
        });
      }
      return;
    }

    const youtubeId = extractYoutubeId(lesson.videoUrl);
    if (!youtubeId) {
      player.innerHTML = `
        <div style="padding: 2rem; background: #fee2e2; color: #991b1b; border-radius: 1rem; text-align: center;">
          <i class="fas fa-exclamation-circle" style="font-size: 2rem; margin-bottom: 1rem;"></i>
          <p>Invalid YouTube URL for this lesson.</p>
        </div>
      `;
      return;
    }

    player.innerHTML = '<div id="youtube-player-host" style="width: 100%; min-height: 500px;"></div>';
    player.style.height = "auto";
    const YT = await loadYoutubeApi();
    new YT.Player("youtube-player-host", {
      videoId: youtubeId,
      width: "100%",
      height: "500",
      playerVars: {
        rel: 0,
        modestbranding: 1,
        autoplay: 0
      },
      events: {
        onStateChange: async (event) => {
          if (event.data === YT.PlayerState.ENDED) {
            try {
              await markLessonComplete();
            } catch (_err) {
              // Ignore and allow manual completion.
            }
          }
        }
      }
    });
  };

  if (!lessonId) {
    if (titleEl) titleEl.textContent = "Lesson not found";
    if (metaEl) metaEl.textContent = "Missing lesson id";
    if (completeBtn) completeBtn.disabled = true;
    return;
  }

  try {
    const [{ video }, progressData] = await Promise.all([
      api.apiFetch(`/videos/${lessonId}`),
      api.apiFetch(`/progress`)
    ]);

    lesson = video;
    if (titleEl) titleEl.textContent = lesson.title || "Lesson Viewer";
    if (backLink && lesson.courseId) {
      backLink.href = `/course-player/?id=${encodeURIComponent(lesson.courseId)}`;
    }
    if (assistantLink) {
      const query = new URLSearchParams({ courseId: lesson.courseId || "", lessonId: lesson.id || "" });
      assistantLink.href = `/assistant/?${query.toString()}`;
    }
    if (quizLink && lesson.quiz) {
      quizLink.href = `/quiz/?id=${encodeURIComponent(lesson.quiz.id)}`;
      quizLink.style.display = "inline-flex";
    }

    const completedItems = new Set(
      (progressData.items || [])
        .filter((item) => item.itemType === "lesson" && item.completed)
        .map((item) => item.referenceId || item.lessonId || item.videoId)
    );
    setCompletedState(completedItems.has(lesson.id));

    if (metaEl) {
      metaEl.innerHTML = `
        <span><i class="fas fa-book"></i> ${escapeHtml(lesson.courseTitle || lesson.courseId)}</span>
        <span><i class="fas fa-play"></i> ${lesson.videoUrl ? (lesson.videoType === "upload" ? "Uploaded video" : "YouTube lesson") : "No video attached"}</span>
        <span><i class="fas fa-file-audio"></i> ${lesson.audioItems.length} audio</span>
        <span><i class="fas fa-folder-open"></i> ${lesson.materials.length} materials</span>
      `;
    }

    if (chipsEl) {
      const tags = lesson.curriculumTags || [];
      const chips = [
        lesson.category ? `<span class="chip"><i class="fas fa-layer-group"></i>${escapeHtml(lesson.category)}</span>` : "",
        ...tags.map((tag) => `<span class="chip"><i class="fas fa-tag"></i>${escapeHtml(tag)}</span>`),
        lesson.caseStudies.length ? `<span class="chip"><i class="fas fa-stethoscope"></i>${lesson.caseStudies.length} case studies</span>` : ""
      ].filter(Boolean);
      chipsEl.innerHTML = chips.join("") || '<span class="chip"><i class="fas fa-bookmark"></i>General lesson</span>';
    }

    if (summaryEl) {
      summaryEl.textContent = lesson.summary || "No summary added yet.";
    }

    renderAudioItems(lesson.audioItems || []);
    renderMaterials(lesson.materials || []);
    renderCaseStudies(lesson.caseStudies || []);
    await renderPlayer();
    await loadAssistantHistory();

    if (completeBtn) {
      completeBtn.addEventListener("click", async () => {
        try {
          await markLessonComplete();
        } catch (err) {
          alert(err.message || "Unable to save progress.");
        }
      });
    }

    if (assistantForm) {
      assistantForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const prompt = String(assistantPrompt?.value || "").trim();
        if (!prompt) {
          return;
        }

        const submitButton = assistantForm.querySelector("button[type='submit']");
        const originalText = submitButton ? submitButton.textContent : "Generate Explanation";
        if (submitButton) {
          submitButton.disabled = true;
          submitButton.textContent = "Generating...";
        }
        assistantResponse.textContent = "Generating explanation...";

        try {
          const data = await api.apiFetch("/assistant/explain", {
            method: "POST",
            body: JSON.stringify({
              prompt,
              courseId: lesson.courseId,
              lessonId: lesson.id
            })
          });
          assistantResponse.textContent = data.answer || "No explanation returned.";
          assistantPrompt.value = "";
          await loadAssistantHistory();
        } catch (err) {
          assistantResponse.textContent = err.message || "Unable to generate explanation right now.";
        } finally {
          if (submitButton) {
            submitButton.disabled = false;
            submitButton.textContent = originalText;
          }
        }
      });
    }
  } catch (err) {
    if (titleEl) titleEl.textContent = "Lesson not found";
    if (metaEl) metaEl.textContent = err.message || "Unable to load lesson";
    if (player) {
      player.innerHTML = `<div style="padding: 2rem; text-align: center; color: white;">${escapeHtml(err.message || "Unable to load lesson")}</div>`;
    }
  }
});
