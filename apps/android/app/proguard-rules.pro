# kotlinx.serialization: keep generated serializers for wire models.
-keepattributes *Annotation*, InnerClasses
-keepclassmembers class com.cultureatlas.capture.core.** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class com.cultureatlas.capture.core.**$$serializer { *; }
