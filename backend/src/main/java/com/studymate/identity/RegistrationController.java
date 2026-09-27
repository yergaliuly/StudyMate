package com.studymate.identity;

import com.studymate.common.api.ApiResponse;
import jakarta.validation.Valid;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
class RegistrationController {
  private final RegistrationService registrations;

  RegistrationController(RegistrationService registrations) { this.registrations = registrations; }

  @PostMapping(path = "/api/v1/auth/register", consumes = MediaType.APPLICATION_JSON_VALUE)
  ResponseEntity<ApiResponse<UserResponse>> register(@Valid @RequestBody RegistrationRequest request) {
    User user = registrations.register(request);
    return ResponseEntity.status(HttpStatus.CREATED).cacheControl(CacheControl.noStore())
        .body(new ApiResponse<>(UserResponse.from(user)));
  }
}
