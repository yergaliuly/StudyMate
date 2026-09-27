package com.studymate.identity;

import java.util.UUID;

public record UserResponse(UUID id, String email, String displayName) {
  static UserResponse from(User user) {
    return new UserResponse(user.id(), user.email(), user.displayName());
  }
}
