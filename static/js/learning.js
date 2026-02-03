document.addEventListener("DOMContentLoaded", async () => {
  const api = window.DentalPrepApi;
  if (!api) return;

  if (!api.requireAuth()) {
    return;
  }

  const videosList = document.getElementById("videos-list");
  const quizzesList = document.getElementById("quizzes-list");
  const analyticsCards = document.getElementById("analytics-cards");

  const renderEmpty = (container, text) => {
    if (!container) return;
    container.innerHTML = `<div class="info-card"><p>${text}</p></div>`;
  };

  const makeCard = (title, meta, buttonText, onClick) => {
    const card = document.createElement("div");
    card.className = "info-card";
    card.innerHTML = `
      <h4>${title}</h4>
      <div class="info-meta">${meta}</div>
      <button class="btn-primary" type="button">${buttonText}</button>
    `;
    const btn = card.querySelector("button");
    btn.addEventListener("click", onClick);
    return card;
  };

  try {
    const [lessonsData, quizzesData, analyticsData, coursesData] = await Promise.all([
      api.apiFetch("/lessons"),
      api.apiFetch("/quizzes"),
      api.apiFetch("/analytics"),
      api.apiFetch("/courses")
    ]);

    const courseLookup = (coursesData.courses || []).reduce((acc, course) => {
      acc[course.id] = course.title;
      return acc;
    }, {});

    if (videosList) {
      videosList.innerHTML = "";
      if (!lessonsData.lessons || lessonsData.lessons.length === 0) {
        renderEmpty(videosList, "No videos available yet.");
      } else {
        lessonsData.lessons.forEach((lesson) => {
          const courseName = courseLookup[lesson.courseId] || "Course";
          const card = makeCard(
            lesson.title,
            `${courseName} • YouTube` ,
            "Watch",
            () => {
              window.location.href = `/video/?id=${lesson.id}`;
            }
          );
          videosList.appendChild(card);
        });
      }
    }

    if (quizzesList) {
      quizzesList.innerHTML = "";
      if (!quizzesData.quizzes || quizzesData.quizzes.length === 0) {
        renderEmpty(quizzesList, "No quizzes available yet.");
      } else {
        quizzesData.quizzes.forEach((quiz) => {
          const lesson = (lessonsData.lessons || []).find((item) => item.id === quiz.lessonId);
          const courseName = lesson ? courseLookup[lesson.courseId] || "Course" : "Course";
          const card = makeCard(
            quiz.title,
            `${courseName} • ${quiz.questions} questions`,
            "Start Quiz",
            () => {
              window.location.href = `/quiz/?id=${quiz.id}`;
            }
          );
          quizzesList.appendChild(card);
        });
      }
    }

    if (analyticsCards) {
      const { totalItems, completedItems, completionRate, avgScore } = analyticsData;
      analyticsCards.innerHTML = `
        <div class="analytics-item">
          <h3>${totalItems || 0}</h3>
          <div class="info-meta">Items Tracked</div>
        </div>
        <div class="analytics-item">
          <h3>${completedItems || 0}</h3>
          <div class="info-meta">Completed</div>
        </div>
        <div class="analytics-item">
          <h3>${completionRate || 0}%</h3>
          <div class="info-meta">Completion Rate</div>
        </div>
        <div class="analytics-item">
          <h3>${avgScore || 0}</h3>
          <div class="info-meta">Average Score</div>
        </div>
      `;
    }
  } catch (err) {
    api.clearToken();
    window.location.href = "/login/";
  }
});
