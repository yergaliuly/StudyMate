package com.studymate.materials;

import com.studymate.common.api.ApiResponse;
import com.studymate.identity.CurrentAccount;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.util.Set;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.*;

@RestController
class MaterialTextController {
  private final CurrentAccount accounts;
  private final MaterialRepository materials;
  private final MaterialTextRepository texts;
  private final ObjectStorage storage;
  MaterialTextController(CurrentAccount accounts,MaterialRepository materials,MaterialTextRepository texts,ObjectStorage storage) {
    this.accounts=accounts; this.materials=materials; this.texts=texts; this.storage=storage;
  }
  @PostMapping("/api/v1/materials/{id}/process")
  ResponseEntity<?> process(@PathVariable String id,Authentication auth,HttpServletRequest request) throws IOException {
    var owner=accounts.requireUser(auth,request).id(); MaterialInput.noQuery(request);
    var materialId=MaterialInput.id(id); var key=MaterialInput.key(request);
    if(request.getInputStream().read()!=-1) throw MaterialInput.error(HttpStatus.BAD_REQUEST,"INVALID_REQUEST","Этот запрос не принимает тело.");
    materials.get(owner,materialId);
    if(!storage.enabled()) throw MaterialInput.error(HttpStatus.SERVICE_UNAVAILABLE,"STORAGE_UNAVAILABLE","Хранилище временно недоступно.");
    return ResponseEntity.accepted().header("Cache-Control","no-store").body(new ApiResponse<>(texts.start(owner,materialId,key)));
  }
  @GetMapping("/api/v1/materials/{id}/pages")
  ResponseEntity<?> pages(@PathVariable String id,@RequestParam MultiValueMap<String,String> query,
      Authentication auth,HttpServletRequest request) {
    var owner=accounts.requireUser(auth,request).id();
    if(!Set.of("page","pageSize").containsAll(query.keySet())) throw MaterialQuery.invalid();
    var paging=MaterialQuery.parse(query);
    return ResponseEntity.ok().header("Cache-Control","no-store")
        .body(texts.pages(owner,MaterialInput.id(id),paging.page(),paging.pageSize()));
  }
}
