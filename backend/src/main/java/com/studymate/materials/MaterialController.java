package com.studymate.materials;

import com.studymate.common.api.ApiResponse;
import com.studymate.identity.CurrentAccount;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import java.net.URI;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.*;

@RestController
class MaterialController {
  private final CurrentAccount accounts;
  private final MaterialService materials;
  MaterialController(CurrentAccount accounts, MaterialService materials) { this.accounts=accounts; this.materials=materials; }

  @PostMapping(path="/api/v1/materials",consumes=MediaType.MULTIPART_FORM_DATA_VALUE)
  ResponseEntity<String> upload(Authentication auth, HttpServletRequest request) throws Exception {
    var owner = accounts.requireUser(auth,request).id();
    var key = MaterialInput.key(request);
    try {
      var result = materials.upload(owner,key,MaterialInput.read(request));
      return ResponseEntity.created(URI.create("/api/v1/materials/"+result.id())).contentType(MediaType.APPLICATION_JSON)
          .header("Cache-Control","no-store").body(result.body());
    } finally {
      try { for (var part : request.getParts()) part.delete(); } catch (Exception ignored) { /* Servlet container also recycles parts. */ }
    }
  }
  @GetMapping("/api/v1/materials")
  ResponseEntity<MaterialRepository.Page> list(@RequestParam MultiValueMap<String,String> query, Authentication auth, HttpServletRequest request) {
    var owner = accounts.requireUser(auth,request).id();
    return ResponseEntity.ok().header("Cache-Control","no-store").body(materials.list(owner,MaterialQuery.parse(query)));
  }
  @GetMapping("/api/v1/materials/{id}")
  ResponseEntity<?> get(@PathVariable String id, Authentication auth, HttpServletRequest request) {
    var owner = accounts.requireUser(auth,request).id(); MaterialInput.noQuery(request);
    return ok(materials.get(owner,MaterialInput.id(id)));
  }
  record Rename(@NotNull String title, @NotNull @Min(1) @Max(9_007_199_254_740_991L) Long version) {}
  @PatchMapping(path="/api/v1/materials/{id}",consumes=MediaType.APPLICATION_JSON_VALUE)
  ResponseEntity<?> rename(@PathVariable String id, @Valid @RequestBody Rename input, Authentication auth, HttpServletRequest request) {
    var owner = accounts.requireUser(auth,request).id(); MaterialInput.noQuery(request);
    return ok(materials.rename(owner,MaterialInput.id(id),MaterialInput.title(input.title()),input.version()));
  }
  @GetMapping("/api/v1/materials/{id}/download")
  ResponseEntity<?> download(@PathVariable String id, Authentication auth, HttpServletRequest request) {
    var owner = accounts.requireUser(auth,request).id(); MaterialInput.noQuery(request);
    return ok(materials.download(owner,MaterialInput.id(id)));
  }
  @DeleteMapping("/api/v1/materials/{id}")
  ResponseEntity<?> delete(@PathVariable String id, Authentication auth, HttpServletRequest request) {
    var owner = accounts.requireUser(auth,request).id(); MaterialInput.noQuery(request);
    return ResponseEntity.accepted().header("Cache-Control","no-store")
        .body(new ApiResponse<>(materials.delete(owner,MaterialInput.id(id))));
  }
  @GetMapping("/api/v1/storage/usage")
  ResponseEntity<?> usage(Authentication auth, HttpServletRequest request) {
    var owner = accounts.requireUser(auth,request).id(); MaterialInput.noQuery(request);
    return ok(materials.usage(owner));
  }
  private static ResponseEntity<?> ok(Object data) { return ResponseEntity.ok().header("Cache-Control","no-store").body(new ApiResponse<>(data)); }
}
