#pragma once

#include <Arduino.h>
#include <ESPAsyncWebServer.h>

void setupApi(AsyncWebServer& server);
bool apiDispatchUsb(const String& method, const String& url, const String& body, int& status, String& content_type,
                    String& response_body, String& response_header_name, String& response_header_value);
