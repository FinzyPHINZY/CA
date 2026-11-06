#!/usr/bin/env node

/**
 * End-to-End Test Script for Project Creation Flow
 *
 * This script tests the complete project creation flow:
 * 1. Authenticates a user
 * 2. Uploads a test file
 * 3. Creates a project with the uploaded media
 * 4. Monitors WebSocket for analysis progress/completion
 * 5. Verifies the project was created successfully
 */

const axios = require('axios');
const { io } = require('socket.io-client');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

// Configuration
const CONFIG = {
  AUTH_URL: process.env.AUTH_URL || 'http://localhost:3001/api',
  CORE_URL: process.env.CORE_URL || 'http://localhost:3000/api',
  FILE_URL: process.env.FILE_URL || 'http://localhost:3004/api',
  WS_URL: process.env.WS_URL || 'http://localhost:3003/notifications',
  TEST_EMAIL:
    process.env.TEST_EMAIL ||
    `test-${Date.now()}-${Math.random().toString(36).substring(7)}@example.com`,
  TEST_PASSWORD: process.env.TEST_PASSWORD || 'TestPassword123!',
  TIMEOUT: 300000, // 5 minutes timeout for analysis
};

// Test state
const testState = {
  token: null,
  userId: null,
  mediaId: null,
  projectId: null,
  taskId: null,
  socket: null,
  progressEvents: [],
  completionEvent: null,
  errors: [],
};

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  const timestamp = new Date().toISOString();
  console.log(`${colors[color]}[${timestamp}] ${message}${colors.reset}`);
}

function error(message) {
  log(`ERROR: ${message}`, 'red');
  testState.errors.push(message);
}

function success(message) {
  log(`✓ ${message}`, 'green');
}

function info(message) {
  log(message, 'cyan');
}

function warning(message) {
  log(`⚠ ${message}`, 'yellow');
}

// Step 1: Check service health
async function checkServices() {
  log('Step 1: Checking service health...', 'blue');

  const services = [
    { name: 'Auth Service', url: CONFIG.AUTH_URL.replace('/api', '/health') },
    { name: 'Core Service', url: CONFIG.CORE_URL.replace('/api', '/health') },
    { name: 'File Service', url: CONFIG.FILE_URL.replace('/api', '/health') },
  ];

  const results = await Promise.allSettled(
    services.map(async (service) => {
      try {
        const response = await axios.get(service.url, { timeout: 5000 });
        return { name: service.name, status: response.status, healthy: true };
      } catch (err) {
        return { name: service.name, healthy: false, error: err.message };
      }
    }),
  );

  let allHealthy = true;
  results.forEach((result) => {
    if (result.status === 'fulfilled') {
      const service = result.value;
      if (service.healthy) {
        success(`${service.name} is healthy`);
      } else {
        error(`${service.name} is not responding: ${service.error}`);
        allHealthy = false;
      }
    } else {
      error(`Failed to check service: ${result.reason}`);
      allHealthy = false;
    }
  });

  if (!allHealthy) {
    warning('Some services are not healthy, but continuing with test...');
  }

  return allHealthy;
}

// Step 2: Authenticate user
async function authenticate() {
  log('Step 2: Authenticating user...', 'blue');

  try {
    // Try to signup first
    try {
      info(`Attempting signup with email: ${CONFIG.TEST_EMAIL}`);
      const signupResponse = await axios.post(
        `${CONFIG.AUTH_URL}/auth/signup`,
        {
          email: CONFIG.TEST_EMAIL,
          password: CONFIG.TEST_PASSWORD,
          fullName: 'Test User',
          role: 'actor',
        },
      );

      success('User signed up successfully');
      info('Signup no longer returns tokens. Attempting login...');

      // Now login to get tokens
      const loginResponse = await axios.post(`${CONFIG.AUTH_URL}/auth/login`, {
        email: CONFIG.TEST_EMAIL,
        password: CONFIG.TEST_PASSWORD,
      });

      testState.token = loginResponse.data.data.accessToken;
      testState.userId = loginResponse.data.data.user.id;
      success('User logged in successfully');
    } catch (signupError) {
      // If signup fails, try login
      if (
        signupError.response?.status === 409 ||
        signupError.response?.status === 400
      ) {
        info('User already exists, attempting login...');
        try {
          const loginResponse = await axios.post(
            `${CONFIG.AUTH_URL}/auth/login`,
            {
              email: CONFIG.TEST_EMAIL,
              password: CONFIG.TEST_PASSWORD,
            },
          );

          testState.token = loginResponse.data.data.accessToken;
          testState.userId = loginResponse.data.data.user.id;
          success('User logged in successfully');
        } catch (loginError) {
          // If login also fails, try with a new unique email
          warning('Login failed, trying with a new unique email...');
          const newEmail = `test-${Date.now()}-${Math.random().toString(36).substring(7)}@example.com`;
          info(`Attempting signup with new email: ${newEmail}`);
          const newSignupResponse = await axios.post(
            `${CONFIG.AUTH_URL}/auth/signup`,
            {
              email: newEmail,
              password: CONFIG.TEST_PASSWORD,
              fullName: 'Test User',
              role: 'actor',
            },
          );

          success('User signed up successfully with new email');
          info('Attempting login with new email...');

          // Login with new email to get tokens
          const newLoginResponse = await axios.post(
            `${CONFIG.AUTH_URL}/auth/login`,
            {
              email: newEmail,
              password: CONFIG.TEST_PASSWORD,
            },
          );

          testState.token = newLoginResponse.data.data.accessToken;
          testState.userId = newLoginResponse.data.data.user.id;
          success('User logged in successfully with new email');
        }
      } else {
        throw signupError;
      }
    }

    if (!testState.token || !testState.userId) {
      throw new Error('Failed to obtain authentication token or user ID');
    }

    info(`User ID: ${testState.userId}`);
    return true;
  } catch (err) {
    error(
      `Authentication failed: ${err.response?.data?.message || err.message}`,
    );
    if (err.response?.data) {
      error(`Response: ${JSON.stringify(err.response.data, null, 2)}`);
    }
    return false;
  }
}

// Step 3: Upload test file
async function uploadFile() {
  log('Step 3: Uploading test file...', 'blue');

  try {
    // Create a sample script file
    const sampleScript = `FADE IN:

INT. OFFICE - DAY

JOHN, a determined detective in his 40s, sits at his desk reviewing case files. The office is cluttered with evidence boxes.

JOHN
(to himself)
This case doesn't add up. Something's missing.

He picks up a photograph and studies it carefully.

JOHN (CONT'D)
Wait... I see it now.

He stands up and grabs his coat.

JOHN (CONT'D)
I need to check something.

FADE OUT.`;

    const tempFilePath = path.join(__dirname, 'temp-test-script.txt');
    fs.writeFileSync(tempFilePath, sampleScript);

    const formData = new FormData();
    const fileStream = fs.createReadStream(tempFilePath);
    formData.append('file', fileStream, {
      filename: 'test-script.txt',
      contentType: 'text/plain',
    });
    formData.append('folder', 'scripts');

    const response = await axios.post(
      `${CONFIG.FILE_URL}/files/upload`,
      formData,
      {
        headers: {
          Authorization: `Bearer ${testState.token}`,
          ...formData.getHeaders(),
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      },
    );

    testState.mediaId = response.data.id;
    success(`File uploaded successfully. Media ID: ${testState.mediaId}`);

    // Clean up temp file
    fs.unlinkSync(tempFilePath);

    return true;
  } catch (err) {
    error(`File upload failed: ${err.response?.data?.message || err.message}`);
    if (err.response?.data) {
      error(`Response: ${JSON.stringify(err.response.data, null, 2)}`);
    }
    return false;
  }
}

// Step 4: Setup WebSocket connection
async function setupWebSocket() {
  log('Step 4: Setting up WebSocket connection...', 'blue');

  return new Promise((resolve, reject) => {
    try {
      testState.socket = io(CONFIG.WS_URL, {
        query: { userId: testState.userId },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: 5,
        timeout: 20000,
      });

      testState.socket.on('connect', () => {
        success('WebSocket connected successfully');
        resolve(true);
      });

      testState.socket.on('connect_error', (err) => {
        error(`WebSocket connection error: ${err.message}`);
        reject(err);
      });

      testState.socket.on('analysis.progress', (data) => {
        info(
          `Progress event received: ${data.progressMessage} (${data.progress || 'N/A'}%)`,
        );
        testState.progressEvents.push(data);
        if (data.taskId) {
          testState.taskId = data.taskId;
        }
      });

      testState.socket.on('analysis.completed', (data) => {
        success('Analysis completed event received!');
        testState.completionEvent = data;
        if (data.taskId) {
          testState.taskId = data.taskId;
        }
      });

      testState.socket.on('disconnect', () => {
        warning('WebSocket disconnected');
      });

      testState.socket.on('error', (err) => {
        error(`WebSocket error: ${err.message || err}`);
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        if (!testState.socket.connected) {
          reject(new Error('WebSocket connection timeout'));
        }
      }, 10000);
    } catch (err) {
      error(`Failed to setup WebSocket: ${err.message}`);
      reject(err);
    }
  });
}

// Step 5: Create project
async function createProject() {
  log('Step 5: Creating project...', 'blue');

  try {
    const projectData = {
      title: `Test Project ${Date.now()}`,
      description: 'End-to-end test project',
      mediaIds: [testState.mediaId],
    };

    info(`Creating project with media ID: ${testState.mediaId}`);
    const response = await axios.post(
      `${CONFIG.CORE_URL}/projects`,
      projectData,
      {
        headers: {
          Authorization: `Bearer ${testState.token}`,
          'Content-Type': 'application/json',
        },
      },
    );

    testState.projectId = response.data.id;
    if (response.data.scripts && response.data.scripts.length > 0) {
      testState.taskId = response.data.scripts[0].taskId;
      info(`Script task ID: ${testState.taskId}`);
    }

    success(`Project created successfully. Project ID: ${testState.projectId}`);
    info(`Project has ${response.data.scripts?.length || 0} script(s)`);

    return true;
  } catch (err) {
    error(
      `Project creation failed: ${err.response?.data?.message || err.message}`,
    );
    if (err.response?.data) {
      error(`Response: ${JSON.stringify(err.response.data, null, 2)}`);
    }
    return false;
  }
}

// Step 6: Wait for analysis completion
async function waitForAnalysisCompletion() {
  log('Step 6: Waiting for analysis completion...', 'blue');

  return new Promise((resolve) => {
    const startTime = Date.now();
    const checkInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;

      if (testState.completionEvent) {
        clearInterval(checkInterval);
        success(`Analysis completed in ${(elapsed / 1000).toFixed(2)} seconds`);
        info(`Received ${testState.progressEvents.length} progress events`);
        resolve(true);
      } else if (elapsed > CONFIG.TIMEOUT) {
        clearInterval(checkInterval);
        error(
          `Analysis timeout after ${(CONFIG.TIMEOUT / 1000).toFixed(0)} seconds`,
        );
        warning(
          `Received ${testState.progressEvents.length} progress events but no completion event`,
        );
        resolve(false);
      } else {
        const progressCount = testState.progressEvents.length;
        if (progressCount > 0) {
          const lastProgress =
            testState.progressEvents[testState.progressEvents.length - 1];
          info(
            `Waiting... (${progressCount} progress events, last: ${lastProgress.progress || 'N/A'}%)`,
          );
        } else {
          info(
            `Waiting for analysis to start... (${(elapsed / 1000).toFixed(0)}s elapsed)`,
          );
        }
      }
    }, 5000); // Check every 5 seconds
  });
}

// Step 7: Verify project
async function verifyProject() {
  log('Step 7: Verifying project...', 'blue');

  try {
    const response = await axios.get(
      `${CONFIG.CORE_URL}/projects/${testState.projectId}`,
      {
        headers: {
          Authorization: `Bearer ${testState.token}`,
        },
      },
    );

    const project = response.data;
    success('Project retrieved successfully');
    info(`Project Title: ${project.title}`);
    info(`Scripts: ${project.scripts?.length || 0}`);

    if (project.scripts && project.scripts.length > 0) {
      const script = project.scripts[0];
      info(`Script Status: ${script.status}`);
      info(`Script Task ID: ${script.taskId}`);

      if (script.status === 'COMPLETED') {
        success('Script analysis completed successfully!');
        if (script.sceneCount) {
          info(`Scenes: ${script.sceneCount}`);
        }
        if (script.characterCount) {
          info(`Characters: ${script.characterCount}`);
        }
      } else if (script.status === 'PROCESSING') {
        warning('Script is still processing');
      } else if (script.status === 'FAILED') {
        error('Script analysis failed');
      }
    }

    return true;
  } catch (err) {
    error(
      `Project verification failed: ${err.response?.data?.message || err.message}`,
    );
    return false;
  }
}

// Cleanup
async function cleanup() {
  log('Cleaning up...', 'blue');

  if (testState.socket) {
    testState.socket.disconnect();
    info('WebSocket disconnected');
  }
}

// Main test flow
async function runTest() {
  log('='.repeat(60), 'bright');
  log('Starting End-to-End Project Creation Flow Test', 'bright');
  log('='.repeat(60), 'bright');
  log('');

  try {
    // Step 1: Check services
    await checkServices();
    log('');

    // Step 2: Authenticate
    if (!(await authenticate())) {
      throw new Error('Authentication failed');
    }
    log('');

    // Step 3: Upload file
    if (!(await uploadFile())) {
      throw new Error('File upload failed');
    }
    log('');

    // Step 4: Setup WebSocket
    await setupWebSocket();
    log('');

    // Step 5: Create project
    if (!(await createProject())) {
      throw new Error('Project creation failed');
    }
    log('');

    // Step 6: Wait for analysis
    await waitForAnalysisCompletion();
    log('');

    // Step 7: Verify project
    await verifyProject();
    log('');

    // Summary
    log('='.repeat(60), 'bright');
    log('Test Summary', 'bright');
    log('='.repeat(60), 'bright');

    if (testState.errors.length === 0) {
      success('All tests passed!');
    } else {
      error(`Test completed with ${testState.errors.length} error(s)`);
      testState.errors.forEach((err, index) => {
        log(`  ${index + 1}. ${err}`, 'red');
      });
    }

    log('');
    log('Test State:', 'cyan');
    log(`  User ID: ${testState.userId}`, 'cyan');
    log(`  Media ID: ${testState.mediaId}`, 'cyan');
    log(`  Project ID: ${testState.projectId}`, 'cyan');
    log(`  Task ID: ${testState.taskId || 'N/A'}`, 'cyan');
    log(`  Progress Events: ${testState.progressEvents.length}`, 'cyan');
    log(
      `  Completion Event: ${testState.completionEvent ? 'Yes' : 'No'}`,
      'cyan',
    );
  } catch (err) {
    error(`Test failed with error: ${err.message}`);
    if (err.stack) {
      log(err.stack, 'red');
    }
    process.exit(1);
  } finally {
    await cleanup();
  }
}

// Run the test
if (require.main === module) {
  runTest()
    .then(() => {
      process.exit(testState.errors.length === 0 ? 0 : 1);
    })
    .catch((err) => {
      error(`Fatal error: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { runTest };
