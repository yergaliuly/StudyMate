package com.studymate.identity;

import java.util.UUID;

record User(UUID id, String email, String displayName) {}
