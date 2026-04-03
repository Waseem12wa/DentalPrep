document.addEventListener("DOMContentLoaded", async () => {
  const api = window.DentalPrepApi;
  if (!api) return;

  const logoutLinks = document.querySelectorAll(".logout-link");
  logoutLinks.forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      api.clearToken();
      window.location.href = "/login/";
    });
  });

  if (!api.requireAuth()) {
    return;
  }

  try {
    const data = await api.getProfile();
    const user = data.user;

    const heading = document.querySelector(".dashboard-header h1");
    if (heading && user && user.name) {
      heading.textContent = `Welcome back, ${user.name}! ðŸ‘‹`;
    }

    const initialsBadge = document.querySelector(".dashboard-header [data-initials]");
    if (initialsBadge && user && user.name) {
      const initials = user.name
        .split(" ")
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0].toUpperCase())
        .join("");
      initialsBadge.textContent = initials || "U";
    }
  } catch (err) {
    console.debug("Profile fetch failed (non-critical):", err.message);
  }

  // Initialize content loaders
  await loadDashboardContent();
});

// Tab switching functionality
function switchDashboardTab(tabName) {
  // Hide all tab contents
  document.querySelectorAll('.tab-content').forEach(tab => {
    tab.classList.add('hidden');
  });
  
  // Remove active state from all buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.style.borderBottomColor = 'transparent';
    btn.style.color = 'var(--text-light)';
  });
  
  // Show selected tab
  const selectedTab = document.getElementById(`tab-${tabName}`);
  if (selectedTab) {
    selectedTab.classList.remove('hidden');
    
    // Highlight active button
    event.target.closest('.tab-btn').style.borderBottomColor = 'var(--primary-color)';
    event.target.closest('.tab-btn').style.color = 'var(--primary-color)';
    
    // Load content if not already loaded
    if (tabName === 'lessons' && !window.lessonsLoaded) {
      loadLessons();
    } else if (tabName === 'quizzes' && !window.quizzesLoaded) {
      loadQuizzes();
    } else if (tabName === 'academy' && !window.academyLoaded) {
      loadAcademyContent();
    }
  }
}

async function loadDashboardContent() {
  const api = window.DentalPrepApi;
  const coursesContainer = document.getElementById('courses-container');
  const noCoursesMsg = document.getElementById('no-courses-msg');
  
  // Load courses initially
  try {
    const coursesData = await api.apiFetch('/courses');
    displayCourses(coursesData.courses || []);
  } catch (err) {
    console.error('Failed to load courses:', err);
    if (coursesContainer) coursesContainer.classList.add('hidden');
    if (noCoursesMsg) noCoursesMsg.classList.remove('hidden');
  }
}

async function loadLessons() {
  const api = window.DentalPrepApi;
  const loader = document.getElementById('lessons-loader');
  const container = document.getElementById('lessons-container');
  const noMsg = document.getElementById('no-lessons-msg');
  
  try {
    const lessonsData = await api.apiFetch('/lessons');
    const lessons = lessonsData.lessons || [];
    
    if (lessons.length === 0) {
      loader.classList.add('hidden');
      noMsg.classList.remove('hidden');
      return;
    }
    
    let html = '<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 1.5rem;">';
    
    lessons.forEach(lesson => {
      html += `
        <div style="background: white; border-radius: var(--border-radius-lg); overflow: hidden; box-shadow: var(--shadow-sm); border: 1px solid var(--gray-200); transition: var(--transition-all);" onmouseover="this.style.boxShadow='var(--shadow-lg)'; this.style.transform='translateY(-5px)'" onmouseout="this.style.boxShadow='var(--shadow-sm)'; this.style.transform='translateY(0)'">
          <div style="height: 160px; background: linear-gradient(135deg, var(--primary-color), var(--secondary-color)); display: flex; align-items: center; justify-content: center; color: white; font-size: 2rem;">
            <i class="fas fa-play-circle"></i>
          </div>
          <div style="padding: 1.5rem;">
            <h3 style="margin: 0 0 0.5rem; font-weight: 700; color: var(--text-dark);">${lesson.title}</h3>
            <p style="margin: 0 0 0.75rem; color: var(--text-light); font-size: 0.9rem;">${lesson.courseTitle || 'Course'}</p>
            <p style="margin: 0 0 1rem; color: #666; font-size: 0.85rem;">${lesson.summary || 'Video lesson'}</p>
            ${lesson.hasVideo ? `<a href="${lesson.videoUrl}" target="_blank" class="cta-btn cta-primary" style="padding: 0.5rem 1rem; font-size: 0.9rem; display: inline-block;">Watch Lesson</a>` : '<button class="cta-btn" style="padding: 0.5rem 1rem; font-size: 0.9rem; background: #ccc; cursor: not-allowed;">Coming Soon</button>'}
          </div>
        </div>
      `;
    });
    
    html += '</div>';
    
    loader.classList.add('hidden');
    container.innerHTML = html;
    container.classList.remove('hidden');
    window.lessonsLoaded = true;
  } catch (err) {
    console.error('Failed to load lessons:', err);
    loader.classList.add('hidden');
    document.getElementById('no-lessons-msg').classList.remove('hidden');
  }
}

async function loadQuizzes() {
  const api = window.DentalPrepApi;
  const loader = document.getElementById('quizzes-loader');
  const listContainer = document.getElementById('quizzes-list');
  const noMsg = document.getElementById('no-quizzes-msg');
  
  try {
    const quizzesData = await api.apiFetch('/quizzes');
    const quizzes = quizzesData.quizzes || [];
    
    if (quizzes.length === 0) {
      loader.classList.add('hidden');
      noMsg.classList.remove('hidden');
      return;
    }
    
    let html = '';
    
    quizzes.forEach(quiz => {
      const scoreDisplay = quiz.bestScore !== null ? `<div style="font-size: 2rem; font-weight: 900; color: var(--primary-color);">${quiz.bestScore}%</div>` : '<div style="color: #ccc; font-weight: 600;">Not attempted</div>';
      
      html += `
        <div style="background: white; border-radius: var(--border-radius-lg); overflow: hidden; box-shadow: var(--shadow-sm); border: 1px solid var(--gray-200); padding: 1.5rem; transition: var(--transition-all);" onmouseover="this.style.boxShadow='var(--shadow-lg)'; this.style.transform='translateY(-5px)'" onmouseout="this.style.boxShadow='var(--shadow-sm)'; this.style.transform='translateY(0)'">
          <h3 style="margin: 0 0 0.5rem; font-weight: 700; color: var(--text-dark);">${quiz.title}</h3>
          <p style="margin: 0 0 1rem; color: var(--text-light); font-size: 0.9rem;"><i class="fas fa-question-circle" style="margin-right: 0.5rem;"></i>${quiz.questions} Questions</p>
          <div style="margin: 1rem 0; text-align: center;">
            ${scoreDisplay}
          </div>
          <button onclick="openQuizSolver('${quiz.id}', '${quiz.title}', '${quiz.courseId}')" class="cta-btn cta-primary" style="width: 100%; padding: 0.75rem; font-size: 0.9rem; border: none; cursor: pointer; border-radius: var(--border-radius-md);">
            ${quiz.bestScore !== null ? 'Retake Quiz' : 'Start Quiz'}
          </button>
        </div>
      `;
    });
    
    loader.classList.add('hidden');
    listContainer.innerHTML = html;
    listContainer.classList.remove('hidden');
    window.quizzesLoaded = true;
  } catch (err) {
    console.error('Failed to load quizzes:', err);
    loader.classList.add('hidden');
    document.getElementById('no-quizzes-msg').classList.remove('hidden');
  }
}

async function openQuizSolver(quizId, quizTitle, courseId) {
  const api = window.DentalPrepApi;
  const solver = document.getElementById('quiz-solver');
  const list = document.getElementById('quizzes-list');
  
  try {
    const quizData = await api.apiFetch(`/quizzes/${quizId}`);
    const questions = quizData.quiz.questions || [];
    
    let html = `
      <button onclick="closeQuizSolver()" style="background: none; border: none; color: var(--primary-color); cursor: pointer; font-size: 1.2rem; margin-bottom: 1rem;"><i class="fas fa-arrow-left"></i> Back</button>
      <h2 style="margin: 0 0 0.5rem; font-size: 1.8rem; font-weight: 900; color: var(--text-dark);">${quizTitle}</h2>
      <p style="margin: 0 0 2rem; color: var(--text-light);">${questions.length} questions â€¢ ${Math.ceil(questions.length * 1.5)} minutes</p>
      <form id="quiz-form" style="max-width: 800px;">
    `;
    
    questions.forEach((q, idx) => {
      html += `
        <div style="margin-bottom: 2.5rem; padding-bottom: 2rem; border-bottom: 1px solid var(--gray-200);">
          <h3 style="margin: 0 0 1rem; font-weight: 700; color: var(--text-dark);">Q${idx + 1}. ${q.question}</h3>
          <div style="display: grid; gap: 0.75rem;">
      `;
      
      (q.options || []).forEach((option, optIdx) => {
        const optionId = `q-${q.id}-opt-${optIdx}`;
        html += `
          <label style="display: flex; align-items: center; padding: 0.75rem; border: 2px solid var(--gray-200); border-radius: var(--border-radius-md); cursor: pointer; transition: all 0.3s;" onmouseover="this.style.backgroundColor='#f3f4f6'" onmouseout="this.style.backgroundColor='transparent'">
            <input type="radio" name="q-${q.id}" value="${option}" id="${optionId}" style="margin-right: 1rem; cursor: pointer;" required>
            <span>${option}</span>
          </label>
        `;
      });
      
      html += `
          </div>
        </div>
      `;
    });
    
    html += `
      <button type="submit" class="cta-btn cta-primary" style="width: 100%; padding: 1rem; font-size: 1rem; border: none; cursor: pointer; border-radius: var(--border-radius-md); margin-top: 1rem;">Submit Quiz</button>
      </form>
    `;
    
    solver.innerHTML = html;
    list.classList.add('hidden');
    solver.classList.remove('hidden');
    
    // Add form submit handler
    document.getElementById('quiz-form').addEventListener('submit', (e) => {
      e.preventDefault();
      submitQuiz(quizId, courseId, questions);
    });
  } catch (err) {
    console.error('Failed to load quiz:', err);
    alert('Failed to load quiz. Please try again.');
  }
}

async function submitQuiz(quizId, courseId, questions) {
  const api = window.DentalPrepApi;
  const form = document.getElementById('quiz-form');
  const answers = {};
  
  questions.forEach(q => {
    const selected = form.querySelector(`input[name="q-${q.id}"]:checked`);
    if (selected) {
      answers[q.id] = selected.value;
    }
  });
  
  try {
    const result = await api.apiFetch('/progress/quiz-submit', {
      method: 'POST',
      body: JSON.stringify({ quizId, courseId, answers })
    });

    // Some backends may return only aggregate score fields. Build a detailed
    // per-question review client-side so bulk-uploaded quizzes still show
    // correct/wrong and correct answers.
    if (!Array.isArray(result.results) || result.results.length === 0) {
      const fallbackResults = (questions || []).map((q) => {
        const studentAnswer = answers[q.id];
        const correctAnswer = q.correctAnswer;
        const isCorrect = studentAnswer === correctAnswer;
        return {
          questionId: q.id,
          question: q.question,
          studentAnswer,
          correctAnswer,
          isCorrect,
          options: q.options || []
        };
      });

      const fallbackCorrect = fallbackResults.filter((r) => r.isCorrect).length;
      result.results = fallbackResults;
      result.correctCount = Number.isFinite(result.correctCount) ? result.correctCount : fallbackCorrect;
      result.totalCount = Number.isFinite(result.totalCount) ? result.totalCount : fallbackResults.length;
      result.score = Number.isFinite(result.score)
        ? result.score
        : (result.totalCount ? Math.round((result.correctCount / result.totalCount) * 100) : 0);
    }
    
    displayQuizResults(result, quizId);
  } catch (err) {
    console.error('Failed to submit quiz:', err);
    alert('Failed to submit quiz. Please try again.');
  }
}

function displayQuizResults(result, quizId) {
  const solver = document.getElementById('quiz-solver');
  
  let html = `
    <div style="text-align: center; padding: 2rem; animation: slideUp 0.6s ease-out;">
      <div style="font-size: 3rem; margin-bottom: 1rem;">
        ${result.score >= 70 ? '<i class="fas fa-check-circle" style="color: #22c55e;"></i>' : '<i class="fas fa-exclamation-circle" style="color: #f97316;"></i>'}
      </div>
      <h2 style="font-size: 2.5rem; font-weight: 900; margin-bottom: 0.5rem;">
        ${result.score}% Score
      </h2>
      <p style="font-size: 1.2rem; color: var(--text-light); margin-bottom: 2rem;">
        You answered ${result.correctCount} out of ${result.totalCount} questions correctly
      </p>
      
      <div style="background: var(--accent-color); padding: 1.5rem; border-radius: var(--border-radius-lg); margin-bottom: 2rem; text-align: left;">
        <h3 style="margin: 0 0 1rem; font-weight: 700; color: var(--text-dark);">Answer Review</h3>
  `;
  
  result.results.forEach((r, idx) => {
    const bgColor = r.isCorrect ? '#d1fae5' : '#fee2e2';
    const textColor = r.isCorrect ? '#065f46' : '#991b1b';
    const statusText = r.isCorrect ? 'Correct' : 'Wrong';
    const studentAnswerText = r.studentAnswer ? r.studentAnswer : 'Not answered';
    
    html += `
      <div style="background: ${bgColor}; border-left: 4px solid ${r.isCorrect ? '#10b981' : '#ef4444'}; padding: 1rem; margin-bottom: 1rem; border-radius: var(--border-radius-md);">
        <p style="margin: 0 0 0.5rem; font-weight: 700; color: ${textColor};">Q${idx + 1}. ${r.question}</p>
        <p style="margin: 0 0 0.25rem; color: ${textColor};"><strong>Status:</strong> ${statusText}</p>
        <p style="margin: 0 0 0.25rem; color: ${textColor};"><strong>Your answer:</strong> ${studentAnswerText}</p>
        ${!r.isCorrect ? `<p style="margin: 0; color: ${textColor};"><strong>Correct answer:</strong> ${r.correctAnswer}</p>` : ''}
      </div>
    `;
  });
  
  html += `
      </div>
      
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
        <button onclick="closeQuizResult()" class="cta-btn cta-secondary" style="padding: 0.75rem; border: 2px solid var(--gray-200); background: white; cursor: pointer; border-radius: var(--border-radius-md);">Back to Quizzes</button>
        <button onclick="openQuizSolver('${quizId}', '', '')" class="cta-btn cta-primary" style="padding: 0.75rem; cursor: pointer; border: none; border-radius: var(--border-radius-md);">Retake Quiz</button>
      </div>
    </div>
  `;
  
  solver.innerHTML = html;
}

function closeQuizSolver() {
  document.getElementById('quiz-solver').classList.add('hidden');
  document.getElementById('quizzes-list').classList.remove('hidden');
}

function closeQuizResult() {
  closeQuizSolver();
}

async function loadAcademyContent() {
  const api = window.DentalPrepApi;
  const loader = document.getElementById('academy-loader');
  const container = document.getElementById('academy-content');
  
  try {
    const academyData = await api.fetch('/academy/content');
    const profile = academyData.profile || {};
    const generalOverview = profile.generalOverview || {};
    
    let html = `
      <div style="background: white; border-radius: var(--border-radius-lg); padding: 2rem; border: 1px solid var(--gray-200);">
        <h3 style="font-size: 1.5rem; font-weight: 900; margin-bottom: 1.5rem; color: var(--text-dark);">General Overview</h3>
    `;
    
    // Books
    if (generalOverview.books && generalOverview.books.length > 0) {
      html += '<h4 style="font-weight: 700; margin-bottom: 0.75rem; color: var(--text-dark);">ðŸ“š Books</h4>';
      html += '<div style="margin-bottom: 1.5rem;">';
      generalOverview.books.forEach(book => {
        if (book.title) {
          html += `<div style="padding: 0.75rem; background: #f3f4f6; border-radius: var(--border-radius-md); margin-bottom: 0.5rem;">
            ${book.url && book.url !== '#' ? `<a href="${book.url}" target="_blank" style="color: var(--primary-color); text-decoration: none; font-weight: 600;">ðŸ“– ${book.title}</a>` : `<span style="color: var(--text-dark); font-weight: 600;">ðŸ“– ${book.title}</span>`}
          </div>`;
        }
      });
      html += '</div>';
    }
    
    // Premium Notes
    if (generalOverview.premiumNotes && generalOverview.premiumNotes.length > 0) {
      html += '<h4 style="font-weight: 700; margin-bottom: 0.75rem; color: var(--text-dark);">âœ¨ Premium Notes</h4>';
      html += '<div style="margin-bottom: 1.5rem;">';
      generalOverview.premiumNotes.forEach(note => {
        if (note.title) {
          html += `<div style="padding: 0.75rem; background: #fffbeb; border-radius: var(--border-radius-md); margin-bottom: 0.5rem;">
            ${note.url && note.url !== '#' ? `<a href="${note.url}" target="_blank" style="color: #b45309; text-decoration: none; font-weight: 600;">âœï¸ ${note.title}</a>` : `<span style="color: var(--text-dark); font-weight: 600;">âœï¸ ${note.title}</span>`}
          </div>`;
        }
      });
      html += '</div>';
    }
    
    // Videos
    if (generalOverview.videos && generalOverview.videos.length > 0) {
      html += '<h4 style="font-weight: 700; margin-bottom: 0.75rem; color: var(--text-dark);">ðŸŽ¥ Videos</h4>';
      html += '<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 1rem;">';
      generalOverview.videos.forEach((video, idx) => {
        html += `<div style="background: linear-gradient(135deg, #ef4444, #f97316); color: white; padding: 1rem; border-radius: var(--border-radius-md); text-align: center;">
          <div style="font-size: 2rem; margin-bottom: 0.5rem;"><i class="fas fa-play-circle"></i></div>
          <p style="margin: 0; font-weight: 600; font-size: 0.9rem;">${video.title}</p>
          ${video.url ? `<a href="${video.url}" target="_blank" style="color: white; text-decoration: none; margin-top: 0.75rem; display: inline-block; font-weight: 600; border-bottom: 2px solid white; padding-bottom: 0.25rem;">Watch</a>` : ''}
        </div>`;
      });
      html += '</div>';
    }
    
    html += '</div>';
    
    loader.classList.add('hidden');
    container.innerHTML = html;
    container.classList.remove('hidden');
    window.academyLoaded = true;
  } catch (err) {
    console.error('Failed to load academy content:', err);
    loader.classList.add('hidden');
    document.getElementById('academy-content').innerHTML = '<div style="text-align: center; py-10"><p>Failed to load academy content.</p></div>';
  }
}

function displayCourses(courses) {
  const container = document.getElementById('courses-container');
  const noMsg = document.getElementById('no-courses-msg');
  const loader = document.getElementById('courses-loader');

  if (!container && !noMsg && !loader) {
    return;
  }
  
  if (!courses || courses.length === 0) {
    if (loader) loader.classList.add('hidden');
    if (container) container.classList.add('hidden');
    if (noMsg) noMsg.classList.remove('hidden');
    return;
  }
  
  let html = '';
  courses.forEach(course => {
    const progressPercent = Math.round((course.lessonsCompleted || 0) / Math.max(course.totalLessons || 1, 1) * 100);
    
    html += `
      <a href="/course-player/?id=${course.id}" style="text-decoration: none; color: inherit;">
        <div style="background: white; border-radius: var(--border-radius-lg); overflow: hidden; box-shadow: var(--shadow-sm); border: 1px solid var(--gray-200); transition: var(--transition-all);" onmouseover="this.style.boxShadow='var(--shadow-lg)'; this.style.transform='translateY(-5px)'" onmouseout="this.style.boxShadow='var(--shadow-sm)'; this.style.transform='translateY(0)'">
          <div style="height: 160px; background: linear-gradient(135deg, var(--primary-color), var(--secondary-color)); display: flex; align-items: center; justify-content: center; color: white; font-size: 2rem;">
            <i class="fas fa-book"></i>
          </div>
          <div style="padding: 1.5rem;">
            <h3 style="margin: 0 0 0.5rem; font-weight: 700; color: var(--text-dark);">${course.title}</h3>
            <p style="margin: 0 0 1rem; color: var(--text-light); font-size: 0.9rem;">${course.lessonsCount || 0} Lessons • ${course.quizCount || 0} Quizzes</p>
            <div style="height: 8px; background: var(--gray-200); border-radius: 4px; overflow: hidden; margin-bottom: 0.5rem;">
              <div style="height: 100%; background: var(--primary-color); width: ${progressPercent}%; transition: width 1s ease-in-out;"></div>
            </div>
            <p style="margin: 0; color: var(--text-light); font-size: 0.85rem;">${progressPercent}% complete</p>
          </div>
        </div>
      </a>
    `;
  });
  
  if (loader) loader.classList.add('hidden');
  if (container) {
    container.innerHTML = html;
    container.classList.remove('hidden');
  }
  if (noMsg) noMsg.classList.add('hidden');
}
